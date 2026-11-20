/* GoPostman 前端：无框架、无构建、无外部依赖。
 * 数据流：state.ws（工作区） -> 控件 -> 写回 state -> 防抖 PUT /api/workspace
 *        请求描述 + 变量表 -> POST /api/send -> 响应渲染 + 脚本断言
 */
'use strict';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];
const BODY_MODES = [
  ['none', 'none'], ['raw', 'raw'], ['formdata', 'form-data'],
  ['urlencoded', 'x-www-form-urlencoded'], ['graphql', 'GraphQL'], ['binary', 'binary'],
];

const state = {
  ws: null,
  activeTabId: null,
  reqTab: 'params',
  respTab: 'pretty',
  side: 'collections',
  collapsed: new Set(JSON.parse(localStorage.getItem('gopostman.collapsed') || '[]')),
  responses: {},      // tabId -> { response, tests }
  respBody: null,     // 最近一次响应体的原始文本 { pretty, raw, lang }，供查找使用
  respSearch: { open: false, term: '', index: 0, total: 0, ranges: [], fallback: false },
  runtimeVars: {},    // 脚本运行期变量，优先级最高
  sending: false,
  cSearch: '',
  hSearch: '',
  runScripts: localStorage.getItem('gopostman.runScripts') !== 'false',
};

// JSON 折叠视图的运行时状态。original 始终是完整、未改动的请求体，
// 折叠只改变 textarea 的「显示值」，绝不写回 state。
const fold = { original: '', blocks: [], collapsed: new Set(), map: [], active: false };
let wrapOn = localStorage.getItem('gopostman.wrap') !== 'false';

// ---------------------------------------------------------------- 基础工具
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = (p) => p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const clone = (o) => JSON.parse(JSON.stringify(o));
const methodClass = (m) => 'm-' + (m || 'get').toLowerCase();
const nonEmpty = (s, d) => (s == null || String(s).trim() === '' ? d : s);

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function fmtBytes(n) {
  if (n == null) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function download(filename, content, type = 'application/json') {
  const blob = new Blob([content], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------- 弹窗
function openModal({ title, body, footer = '', wide = false, onMount, onClose }) {
  const root = $('#modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head"><div class="modal-title">${esc(title)}</div><button class="modal-close" data-close>&times;</button></div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  root.appendChild(backdrop);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  $$('.code-area', backdrop).forEach(el => el.classList.toggle('wrap', wrapOn));
  if (onMount) onMount(backdrop, close);
  return { el: backdrop, close };
}

function promptModal(title, value = '', label = '名称') {
  return new Promise(resolve => {
    let result = null;
    openModal({
      title,
      body: `<div class="form-row"><label>${esc(label)}</label><input class="input" id="prompt-value" value="${esc(value)}"></div>`,
      footer: `<button class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" id="prompt-ok">确定</button>`,
      onClose: () => resolve(result),
      onMount(el, close) {
        const input = $('#prompt-value', el);
        input.focus(); input.select();
        const ok = () => { result = input.value.trim() || null; close(); };
        $('#prompt-ok', el).onclick = ok;
        input.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
      },
    });
  });
}

function confirmModal(title, message) {
  return new Promise(resolve => {
    let decision = false;
    openModal({
      title,
      body: `<div style="line-height:1.8;font-size:13px">${esc(message)}</div>`,
      footer: `<button class="btn btn-ghost" data-close>取消</button><button class="btn btn-danger" id="confirm-ok">确定</button>`,
      onClose: () => resolve(decision),
      onMount(el, close) {
        $('#confirm-ok', el).onclick = () => { decision = true; close(); };
      },
    });
  });
}

// ---------------------------------------------------------------- 网络
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.error) data.error = 'HTTP ' + res.status;
  return data;
}

async function loadWorkspace() {
  const ws = await api('/api/workspace');
  // 前端也做一次规范化：保证所有传给 KV 表格的都是 state 上的真实数组引用，
  // 否则「添加一行」会写进临时数组，保存时凭空消失。
  const arr = (v) => Array.isArray(v) ? v : [];
  ws.collections = arr(ws.collections);
  ws.environments = arr(ws.environments);
  ws.globals = arr(ws.globals);
  ws.history = arr(ws.history);
  ws.tabs = arr(ws.tabs);
  ws.settings = Object.assign({
    timeoutMs: 0, followRedirects: true, insecureSkipVerify: true,
    maxBodyBytes: 8388608, saveHistory: true, historyLimit: 1000, settingsVersion: 2,
  }, ws.settings || {});
  ws.collections.forEach(c => { c.items = arr(c.items); c.variables = arr(c.variables); });
  ws.environments.forEach(e => { e.values = arr(e.values); });
  state.ws = ws;
  state.activeTabId = ws.activeTabId || (ws.tabs[0] && ws.tabs[0].id);
  if (!state.ws.tabs.length) newTab(false);
  const meta = await api('/api/meta');
  $('#footer-status').textContent = `本机数据 · Cookie ${meta.cookieCount} 项`;
}

const saveState = (s) => {
  $('#save-state').textContent = s;
  $('#save-state').classList.toggle('saving', s === '保存中…');
};

async function saveNow() {
  if (!state.ws) return;
  state.ws.activeTabId = state.activeTabId;
  saveState('保存中…');
  try {
    const r = await api('/api/workspace', { method: 'PUT', body: JSON.stringify(state.ws) });
    saveState(r.ok ? '已保存到本机' : '保存失败');
  } catch (e) {
    saveState('保存失败');
    toast('无法写入本地数据: ' + e.message, 'error');
  }
}
const saveSoon = debounce(saveNow, 500);
const touch = () => { activeTab() && (activeTab().dirty = true); saveSoon(); renderTabs(); };

// ---------------------------------------------------------------- 变量
function activeTab() { return state.ws.tabs.find(t => t.id === state.activeTabId); }
function activeEnv() { return state.ws.environments.find(e => e.id === state.ws.activeEnvId); }
function emptyRequest() {
  return { method: 'GET', url: '', params: [], headers: [], body: { mode: 'none' }, auth: { type: 'inherit' }, preScript: '', testScript: '' };
}
function ensureRequest(r) {
  r = r || {};
  const body = Object.assign({ mode: 'none' }, r.body || {});
  body.formData = Array.isArray(body.formData) ? body.formData : [];
  body.urlEncoded = Array.isArray(body.urlEncoded) ? body.urlEncoded : [];
  return {
    method: nonEmpty(r.method, 'GET'), url: r.url || '',
    params: Array.isArray(r.params) ? r.params : [],
    headers: Array.isArray(r.headers) ? r.headers : [],
    body, auth: r.auth || { type: 'inherit' },
    preScript: r.preScript || '', testScript: r.testScript || '', description: r.description || '',
  };
}

function findCollectionByTab(tab) {
  if (!tab || !tab.collectionId) return null;
  return state.ws.collections.find(c => c.id === tab.collectionId) || null;
}

function collectVars() {
  const map = {};
  const put = (rows) => (rows || []).forEach(kv => { if (!kv.disabled && kv.key) map[kv.key] = String(kv.value ?? ''); });
  put(state.ws.globals);
  const col = findCollectionByTab(activeTab());
  if (col) put(col.variables);
  if (activeEnv()) put(activeEnv().values);
  Object.assign(map, state.runtimeVars);
  return map;
}

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
function resolvePreview(s) {
  const vars = collectVars();
  return String(s || '').replace(VAR_RE, (m, key) => {
    const k = key.trim();
    if (k.startsWith('$')) return m;
    return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m;
  });
}
function missingVars(s) {
  const out = [];
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(String(s || '')))) {
    const k = m[1].trim();
    if (!k.startsWith('$') && !Object.prototype.hasOwnProperty.call(collectVars(), k)) out.push(k);
  }
  return out;
}

// ---------------------------------------------------------------- URL ⇄ Params 双向联动
// URL 栏是 query 的唯一真实来源，Params 表是它的结构化视图。
// 两者都显示用户输入的原始内容，页面永不回写 %3E 这类转换结果；
// 只在 /api/send 发送时由后端做一次幂等编码（= 在值里保持原样）。
function splitURL(raw) {
  const s = raw || '';
  const hashIdx = s.indexOf('#');
  const hash = hashIdx >= 0 ? s.slice(hashIdx) : '';
  const main = hashIdx >= 0 ? s.slice(0, hashIdx) : s;
  const qIdx = main.indexOf('?');
  return {
    base: qIdx >= 0 ? main.slice(0, qIdx) : main,
    query: qIdx >= 0 ? main.slice(qIdx + 1) : '',
    hash,
  };
}

// 页面上的 URL 完全保持用户输入的原始内容：> = < : , 空格 . * 等一律不编码。
// 只有 & # 会改变 query 结构（被当成参数分隔符 / URL 锚点），必须转义；
// 真正的发送编码由后端 /api/send 统一处理。
function rawQueryPart(s) {
  return String(s ?? '').replace(/[&#]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

function decodeQueryPart(s) {
  try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); }
  catch (_) { return String(s); }
}

// URL 栏编辑 -> 刷新 Params 表（保留被禁用的行，避免切换后丢失值）
function syncParamsFromURL(r, backfill = false) {
  const { query } = splitURL(r.url);
  const oldRows = r.params || [];
  const oldDisabled = oldRows.filter(p => p.disabled && p.key);
  const oldEnabled = oldRows.filter(p => !p.disabled && p.key);
  const parsed = [];
  if (query) {
    query.split('&').filter(seg => seg !== '').forEach(seg => {
      const eq = seg.indexOf('=');
      if (eq < 0) {
        parsed.push({ key: decodeQueryPart(seg), value: '', disabled: false, type: 'text', noEq: true });
      } else {
        const rawValue = seg.slice(eq + 1);
        // "key=" 里显式写了等号：即使值为空也保留（explicitEq）。
        // 这和 Params 表里"没填 value"不同，后者默认不写等号。
        parsed.push({
          key: decodeQueryPart(seg.slice(0, eq)), value: decodeQueryPart(rawValue),
          disabled: false, type: 'text', explicitEq: rawValue === '',
        });
      }
    });
  }
  // 仅在加载/切换标签时回填旧数据；用户手动删掉 URL 里的 ? 时不能把参数又塞回去
  if (backfill && !query) oldEnabled.forEach(p => parsed.push({ ...p }));
  oldDisabled.forEach(d => {
    if (!parsed.some(p => p.key === d.key && p.value === d.value)) parsed.push({ ...d });
  });
  r.params = parsed;
  // 旧数据 URL 没 query 但 Params 有值，补进 URL
  if (backfill && !query && parsed.some(p => !p.disabled && p.key)) syncURLFromParams(r);
}

// 参数值是否为空。不能用 === ''：导入或历史数据里的 value 可能是 null / undefined，
// 那种行会被误判成"有值"，从而在 URL 末尾多拼一个 "="。
function isEmptyValue(v) {
  return v === undefined || v === null || v === '';
}

// 参数行 -> URL 里的片段。三种情况：
// 1) 裸参数（noEq）：只写 key，不写等号；
// 2) URL 里显式写了空等号（explicitEq）：保留 "key="；
// 3) Params 表里没填 value：默认不保留等号，只写 key。
function paramPair(p) {
  const key = rawQueryPart(p.key);
  if (p.noEq) return key;
  if (isEmptyValue(p.value)) return p.explicitEq ? key + '=' : key;
  return key + '=' + rawQueryPart(p.value);
}

// Params 表编辑 -> 回写 URL 栏
function syncURLFromParams(r) {
  const { base, hash } = splitURL(r.url);
  const pairs = (r.params || []).filter(p => !p.disabled && p.key).map(paramPair);
  r.url = base + (pairs.length ? '?' + pairs.join('&') : '') + hash;
  const input = $('#url-input');
  if (input) input.value = r.url;
  renderUrlHint();
}

function renderParamsKV() {
  const r = activeTab().request;
  renderKV('#params-kv', r.params, {
    key: 'Key', value: 'Value', query: true,
    onChange: () => { syncURLFromParams(activeTab().request); touch(); renderCounts(); },
  });
}

// ---------------------------------------------------------------- JSON 编辑器：折叠 / 换行 / 高度
const blockKey = (b) => b.start + '-' + b.end;

// 扫描文本做括号配对，跳过字符串字面量里的括号，得到可折叠的行区间。
function computeJsonBlocks(text) {
  const stack = [];
  const blocks = [];
  let line = 0, inStr = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') { line++; continue; }
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') stack.push({ line, ch });
    else if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if (open) blocks.push({ start: open.line, end: line });
    }
  }
  return blocks.filter(b => b.end > b.start).sort((a, b) => a.start - b.start || b.end - a.end);
}

// 「折叠全部」只折最外层子块：嵌套块被父块盖住，折了也看不见。
function topLevelBlocks(blocks) {
  const candidates = blocks.filter(b => b.start > 0);
  return candidates.filter(b => !candidates.some(o =>
    o !== b && o.start <= b.start && o.end >= b.end && (o.start < b.start || o.end > b.end)));
}

function renderFold() {
  const ta = $('#raw-body');
  if (!ta) return;
  const status = $('#fold-status');
  if (!fold.collapsed.size) {
    fold.active = false;
    ta.value = fold.original;
    ta.readOnly = false;
    ta.classList.remove('folded');
    fold.map = fold.original.split('\n').map((_, i) => ({ origLine: i }));
    if (status) status.textContent = '';
    return;
  }
  const lines = fold.original.split('\n');
  const out = [], map = [];
  let i = 0;
  while (i < lines.length) {
    const b = fold.blocks.find(x => x.start === i && x.end > i && fold.collapsed.has(blockKey(x)));
    if (b) {
      out.push(lines[i].replace(/\s+$/, '') + `  … ${b.end - b.start} 行`);
      map.push({ origLine: i, folded: b });
      i = b.end + 1;
    } else {
      out.push(lines[i]);
      map.push({ origLine: i });
      i++;
    }
  }
  fold.active = true;
  fold.map = map;
  ta.value = out.join('\n');
  ta.readOnly = true; // 只读预览，避免用户误改摘要文本
  ta.classList.add('folded');
  if (status) status.textContent = `已折叠 ${fold.collapsed.size} 处 · 双击折叠行展开`;
}

function resetFold(text) {
  fold.original = text || '';
  fold.blocks = computeJsonBlocks(fold.original);
  fold.collapsed.clear();
  renderFold();
}

function toggleFoldAtLine(displayLine) {
  const entry = fold.map[displayLine];
  const origLine = entry ? entry.origLine : displayLine;
  if (entry && entry.folded) {
    fold.collapsed.delete(blockKey(entry.folded));
    renderFold();
    return;
  }
  // 找包含该行的最内层块
  const target = fold.blocks
    .filter(b => b.start <= origLine && b.end >= origLine)
    .sort((a, b) => b.start - a.start)[0];
  if (!target) { toast('这一行没有可折叠的对象或数组', 'error'); return; }
  fold.collapsed.add(blockKey(target));
  // 子块已被父块覆盖，移除以免展开时状态混乱
  for (const k of [...fold.collapsed]) {
    const c = fold.blocks.find(x => blockKey(x) === k);
    if (c && c !== target && c.start >= target.start && c.end <= target.end) fold.collapsed.delete(k);
  }
  renderFold();
}

function foldAllBlocks() {
  if (!fold.active) {
    fold.original = $('#raw-body').value;
    fold.blocks = computeJsonBlocks(fold.original);
  }
  const top = topLevelBlocks(fold.blocks);
  if (!top.length) { toast('没有可折叠的 JSON 块，先点「格式化 JSON」试试', 'error'); return; }
  fold.collapsed = new Set(top.map(blockKey));
  renderFold();
  toast(`已折叠 ${top.length} 个块`, 'success');
}

function expandAllBlocks() {
  fold.collapsed.clear();
  renderFold();
}

function applyWrap() {
  $$('.code-area').forEach(el => el.classList.toggle('wrap', wrapOn));
  const btn = $('#btn-wrap-toggle');
  if (btn) {
    btn.textContent = '自动换行：' + (wrapOn ? '开' : '关');
    btn.classList.toggle('active', wrapOn);
  }
  localStorage.setItem('gopostman.wrap', String(wrapOn));
}

// 请求区与响应区共用一条高度基准：请求区变高，响应区（flex:1）自动变矮，反之亦然。
let currentPanePct = null;
function paneBounds() {
  const split = $('.split');
  const pane = $('.request-pane');
  const measured = split ? split.getBoundingClientRect().height : 0;
  const total = measured > 0 ? measured : 600; // jsdom / 首帧兜底
  return { pane, total, min: 180, max: Math.max(220, total - 150) };
}
function applyPaneHeight(px) {
  const { pane, total, min, max } = paneBounds();
  const clamped = Math.max(min, Math.min(max, px));
  currentPanePct = clamped / total * 100;
  if (pane) pane.style.flex = `0 0 ${currentPanePct.toFixed(2)}%`;
  return clamped;
}
function persistPane() {
  if (currentPanePct != null) localStorage.setItem('gopostman.requestPanePct', String(currentPanePct));
}
function persistEditorHeight(id, h) {
  let heights = {};
  try { heights = JSON.parse(localStorage.getItem('gopostman.editorHeights') || '{}'); } catch (_) { heights = {}; }
  heights[id] = h;
  localStorage.setItem('gopostman.editorHeights', JSON.stringify(heights));
}

// 给每个常驻文本框插入一条整边可拖的手柄，替代只在右下角的原生 resize。
// 拖文本框时同步改变请求区高度，让下方响应区对应缩小/放大。
function setupResizableEditors() {
  let heights = {};
  try { heights = JSON.parse(localStorage.getItem('gopostman.editorHeights') || '{}'); } catch (_) { heights = {}; }
  const savedPct = parseFloat(localStorage.getItem('gopostman.requestPanePct'));
  if (savedPct > 0 && savedPct < 100) {
    currentPanePct = savedPct;
    $('.request-pane').style.flex = `0 0 ${savedPct}%`;
  }
  $$('.code-area').forEach((ta) => {
    // raw Body 由 flex 填满整个请求区，高度随请求区/响应区联动，不再单独设固定高度
    const flexFilled = ta.id === 'raw-body';
    if (heights[ta.id] && !flexFilled) ta.style.height = heights[ta.id] + 'px';
    const handle = document.createElement('div');
    handle.className = 'editor-resize';
    handle.title = '按住拖动调整高度（整条横条都可以拖，响应区会同步缩放）';
    ta.insertAdjacentElement('afterend', handle);
    let startY = 0, startTextH = 0, startPaneH = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      startTextH = ta.getBoundingClientRect().height || 130;
      startPaneH = $('.request-pane').getBoundingClientRect().height || 300;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const paneNew = applyPaneHeight(startPaneH + e.clientY - startY);
      const applied = paneNew - startPaneH;
      const textNew = Math.max(90, Math.min(700, startTextH + applied));
      if (!flexFilled) {
        ta.style.height = textNew + 'px';
        heights[ta.id] = textNew;
      }
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('gopostman.editorHeights', JSON.stringify(heights));
      persistPane();
    });
  });
}

function currentTextareaLine(ta) {
  return ta.value.slice(0, ta.selectionStart || 0).split('\n').length - 1;
}

// ---------------------------------------------------------------- 渲染：顶栏 / 侧栏
function renderEnvSelect() {
  const sel = $('#env-select');
  sel.innerHTML = '<option value="">无环境</option>' +
    state.ws.environments.map(e => `<option value="${esc(e.id)}" ${e.id === state.ws.activeEnvId ? 'selected' : ''}>${esc(e.name)}</option>`).join('');
}

function renderSidebar() {
  $$('.sidebar-tab').forEach(b => b.classList.toggle('active', b.dataset.side === state.side));
  $$('.side-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== state.side));
  renderCollections();
  renderHistory();
  renderEnvList();
}

function renderCollections() {
  const root = $('#collection-tree');
  const q = state.cSearch.trim().toLowerCase();
  const items = state.ws.collections.map(col => {
    const filtered = filterItems(col.items || [], q);
    if (q && !col.name.toLowerCase().includes(q) && filtered.length === 0) return '';
    return renderCollectionNode(col, q ? filtered : (col.items || []));
  }).join('');
  root.innerHTML = items;
  $('#collection-empty').classList.toggle('hidden', !!items);
}

function filterItems(items, q) {
  if (!q) return items;
  const out = [];
  for (const it of items) {
    const kids = filterItems(it.items || [], q);
    const match = (it.name || '').toLowerCase().includes(q) || (it.request?.url || '').toLowerCase().includes(q);
    if (match || kids.length) out.push({ ...it, items: it.type === 'folder' ? kids : it.items });
  }
  return out;
}

function renderCollectionNode(col, items) {
  const open = !state.collapsed.has(col.id);
  const children = items.map(it => renderItemNode(it, col)).join('');
  return `<div class="tree-item">
    <div class="tree-row tree-col" data-col="${esc(col.id)}">
      <span class="tree-caret ${open ? 'open' : ''}" data-toggle-col="${esc(col.id)}">&#9654;</span>
      <span class="tree-icon" style="color:var(--accent)">&#9635;</span>
      <span class="tree-name tree-col-name">${esc(col.name)}</span>
      <span class="tree-actions">
        <button class="tree-action" data-col-add="${esc(col.id)}" title="新建请求">+</button>
        <button class="tree-action" data-col-folder="${esc(col.id)}" title="新建文件夹">&#9635;</button>
        <button class="tree-action" data-col-export="${esc(col.id)}" title="导出为 Postman 集合">&uarr;</button>
        <button class="tree-action" data-col-rename="${esc(col.id)}" title="重命名">&#9998;</button>
        <button class="tree-action danger" data-col-delete="${esc(col.id)}" title="删除">&times;</button>
      </span>
    </div>
    <div class="tree-children ${open ? '' : 'hidden'}">${children || '<div class="side-empty" style="text-align:left;padding:6px 10px">空集合</div>'}</div>
  </div>`;
}

function renderItemNode(item, col) {
  if (item.type === 'folder') {
    const open = !state.collapsed.has(item.id);
    return `<div class="tree-item">
      <div class="tree-row" data-folder="${esc(item.id)}">
        <span class="tree-caret ${open ? 'open' : ''}" data-toggle="${esc(item.id)}">&#9654;</span>
        <span class="tree-icon" style="color:var(--amber)">&#9783;</span>
        <span class="tree-name">${esc(item.name)}</span>
        <span class="tree-actions">
          <button class="tree-action" data-folder-add="${esc(col.id)}|${esc(item.id)}" title="在此新建请求">+</button>
          <button class="tree-action" data-item-rename="${esc(col.id)}|${esc(item.id)}" title="重命名">&#9998;</button>
          <button class="tree-action danger" data-item-delete="${esc(col.id)}|${esc(item.id)}" title="删除">&times;</button>
        </span>
      </div>
      <div class="tree-children ${open ? '' : 'hidden'}">${(item.items || []).map(i => renderItemNode(i, col)).join('')}</div>
    </div>`;
  }
  const r = item.request || {};
  const selected = activeTab() && activeTab().savedId === item.id;
  return `<div class="tree-item">
    <div class="tree-row ${selected ? 'selected' : ''}" data-open="${esc(col.id)}|${esc(item.id)}">
      <span class="tree-caret"></span>
      <span class="tree-icon method-label ${methodClass(r.method)}">${esc((r.method || 'GET').slice(0, 4))}</span>
      <span class="tree-name" title="${esc(r.url || item.name)}">${esc(item.name)}</span>
      <span class="tree-actions">
        <button class="tree-action" data-item-dup="${esc(col.id)}|${esc(item.id)}" title="复制请求">&#10697;</button>
        <button class="tree-action" data-item-rename="${esc(col.id)}|${esc(item.id)}" title="重命名">&#9998;</button>
        <button class="tree-action danger" data-item-delete="${esc(col.id)}|${esc(item.id)}" title="删除">&times;</button>
      </span>
    </div>
  </div>`;
}

function renderHistory() {
  const q = state.hSearch.trim().toLowerCase();
  const list = (state.ws.history || []).filter(h => !q || (h.url || '').toLowerCase().includes(q) || (h.method || '').toLowerCase().includes(q));
  $('#history-list').innerHTML = list.map(h => `
    <div class="history-item" data-history="${esc(h.id)}">
      <div class="history-top">
        <span class="method-label ${methodClass(h.method)}">${esc(h.method)}</span>
        <span class="history-url" title="${esc(h.url)}">${esc(h.url)}</span>
      </div>
      <div class="history-meta">
        <span class="${h.statusCode >= 200 && h.statusCode < 400 ? 'm-get' : 'm-delete'}">${h.statusCode || 'ERR'}</span>
        <span>${h.timeMs} ms</span><span>${new Date(h.at).toLocaleString('zh-CN')}</span>
      </div>
    </div>`).join('');
  $('#history-empty').classList.toggle('hidden', list.length > 0);
}

function renderEnvList() {
  $('#env-list').innerHTML = state.ws.environments.map(e => `
    <div class="env-item ${e.id === state.ws.activeEnvId ? 'active' : ''}" data-env="${esc(e.id)}">
      <div class="env-item-head"><span>${esc(e.name)}</span><span class="env-count">${(e.values || []).length} 变量</span></div>
    </div>`).join('') || '<div class="side-empty">还没有环境</div>';
  $('#globals-list').innerHTML = `<div class="env-item" data-env="__globals__">
    <div class="env-item-head"><span>Globals</span><span class="env-count">${(state.ws.globals || []).length} 变量</span></div></div>`;
}

// ---------------------------------------------------------------- 渲染：标签 / 请求
function renderTabs() {
  $('#tabs').innerHTML = state.ws.tabs.map(t => `
    <div class="tab ${t.id === state.activeTabId ? 'active' : ''}" data-tab="${esc(t.id)}">
      <span class="method-label ${methodClass(t.request?.method)}">${esc((t.request?.method || 'GET').slice(0, 4))}</span>
      <span class="tab-name" title="${esc(t.name)}">${esc(t.name || '新请求')}</span>
      ${t.dirty ? '<span class="tab-dirty" title="未保存的改动"></span>' : ''}
      <button class="tab-close" data-tabclose="${esc(t.id)}" title="关闭">&times;</button>
    </div>`).join('');
}

function renderRequest() {
  const tab = activeTab();
  if (!tab) return;
  tab.request = ensureRequest(tab.request);
  const r = tab.request;
  $('#method-select').value = METHODS.includes(r.method) ? r.method : 'GET';
  $('#url-input').value = r.url;
  syncParamsFromURL(r, true);
  $('#url-input').value = r.url;
  resetFold(r.body.raw || '');
  $('#raw-lang').value = r.body.rawLang || 'json';
  $('#graphql-query').value = r.body.graphqlQuery || '';
  $('#graphql-vars').value = r.body.graphqlVariables || '';
  $('#binary-base64').value = r.body.binaryData || '';
  $('#binary-info').textContent = r.body.binaryName ? `已选择文件：${r.body.binaryName}` : '选择一个文件，或粘贴 base64 内容。';
  $('#pre-script').value = r.preScript || '';
  $('#test-script').value = r.testScript || '';
  $('#auth-type').value = r.auth?.type || 'inherit';
  renderParamsKV();
  renderKV('#headers-kv', r.headers, { key: 'Key', value: 'Value', onChange: () => { touch(); renderCounts(); } });
  renderKV('#formdata-kv', r.body.formData, { key: 'Key', value: 'Value', file: true, onChange: () => { touch(); renderCounts(); } });
  renderKV('#urlencoded-kv', r.body.urlEncoded, { key: 'Key', value: 'Value', onChange: () => { touch(); renderCounts(); } });
  renderBodyMode();
  renderAuthFields();
  renderCounts();
  renderUrlHint();
  const cached = state.responses[tab.id];
  if (cached) renderResponse(cached.response, cached.tests);
  else renderEmptyResponse();
}

function renderCounts() {
  const r = activeTab().request;
  const enabled = rows => (rows || []).filter(x => !x.disabled && x.key).length;
  $('#count-params').textContent = enabled(r.params);
  $('#count-headers').textContent = enabled(r.headers);
  $('#count-body').textContent = r.body.mode && r.body.mode !== 'none' ? '1' : '';
  $('#count-auth').textContent = r.auth?.type && !['none', 'inherit'].includes(r.auth.type) ? '1' : '';
  $('#count-tests').textContent = r.testScript ? '1' : '';
}

function renderUrlHint() {
  const r = activeTab().request;
  if (!r.url) { $('#url-hint').innerHTML = '提示：URL 支持 <code>{{变量}}</code>，路径以 / 开头会自动指向本机服务。'; return; }
  let resolved = resolvePreview(r.url);
  if (resolved.startsWith('/')) resolved = location.origin + resolved;
  const missing = missingVars(r.url);
  $('#url-hint').innerHTML = `实际请求：<code>${esc(resolved)}</code>` +
    (missing.length ? ` <span class="var-missing">未解析变量：${esc(missing.join(', '))}</span>` : ` <span class="var-ok">变量已就绪</span>`);
}

function renderBodyMode() {
  const mode = activeTab().request.body.mode || 'none';
  $('#body-mode').innerHTML = BODY_MODES.map(([v, label]) => `<button class="radio-chip ${v === mode ? 'active' : ''}" data-bodymode="${v}">${label}</button>`).join('');
  ['none', 'raw', 'formdata', 'urlencoded', 'graphql', 'binary'].forEach(m => {
    $('#body-' + m).classList.toggle('hidden', m !== mode);
  });
  $('#raw-lang').classList.toggle('hidden', mode !== 'raw');
  // 格式化按钮紧跟格式下拉框，只在 raw 模式下有意义
  $('#btn-format-json').classList.toggle('hidden', mode !== 'raw');
  // raw 模式让文本框 flex 填满请求区，底边紧贴响应区
  $('[data-reqpanel="body"]').classList.toggle('raw-active', mode === 'raw');
}

function renderAuthFields() {
  const a = activeTab().request.auth || { type: 'inherit' };
  const input = (id, label, val, type = 'text', placeholder = '') =>
    `<div class="form-row"><label>${label}</label><input class="input" id="${id}" type="${type}" value="${esc(val || '')}" placeholder="${esc(placeholder)}"></div>`;
  let html = '';
  switch (a.type) {
    case 'bearer':
      html = input('auth-bearer', 'Token', a.bearer, 'text', '支持 {{token}}');
      break;
    case 'basic':
      html = input('auth-user', '用户名', a.username) + input('auth-pass', '密码', a.password, 'password');
      break;
    case 'apikey':
      html = input('auth-key', 'Key', a.apiKeyKey) + input('auth-value', 'Value', a.apiKeyValue) +
        `<div class="form-row"><label>添加到</label><select class="select" id="auth-in">
          <option value="header" ${a.apiKeyIn !== 'query' ? 'selected' : ''}>Header</option>
          <option value="query" ${a.apiKeyIn === 'query' ? 'selected' : ''}>Query Params</option></select></div>`;
      break;
    default:
      html = '<p class="muted" style="margin:6px 0;font-size:12px">此请求不使用认证，或继承集合设置。</p>';
  }
  $('#auth-fields').innerHTML = html;
  $$('#auth-fields input, #auth-fields select').forEach(el => {
    el.addEventListener('input', () => {
      const r = activeTab().request;
      r.auth = r.auth || { type: 'inherit' };
      const map = {
        'auth-bearer': 'bearer', 'auth-user': 'username', 'auth-pass': 'password',
        'auth-key': 'apiKeyKey', 'auth-value': 'apiKeyValue', 'auth-in': 'apiKeyIn',
      };
      r.auth[map[el.id]] = el.value;
      touch();
    });
  });
}

// KV 表格：所有面板共用。编辑时直接改数组对象，不重绘，从而不丢焦点。
function renderKV(selector, rows, opts) {
  const root = $(selector);
  rows = rows || [];
  if (!Array.isArray(rows)) rows = [];
  const head = `<div class="kv-head"><div class="kv-check"></div><div>${esc(opts.key)}</div><div>${esc(opts.value)}</div><div></div></div>`;
  const body = rows.map((row, i) => {
    const isFile = opts.file && row.type === 'file';
    let valueCell;
    if (isFile) {
      valueCell = `<label class="kv-file" title="点击选择文件">${esc(row.fileName || '选择文件…')}
        <input type="file" data-row="${i}" data-field="file" style="display:none"></label>`;
    } else {
      valueCell = `<input class="kv-input" data-row="${i}" data-field="value" value="${esc(row.value || '')}" placeholder="Value">`;
    }
    const typeSel = opts.file ? `<select class="kv-type" data-row="${i}" data-field="type">
      <option value="text" ${row.type !== 'file' ? 'selected' : ''}>Text</option>
      <option value="file" ${row.type === 'file' ? 'selected' : ''}>File</option></select>` : '';
    return `<div class="kv-row ${row.disabled ? 'disabled' : ''}">
      <div class="kv-check"><input type="checkbox" data-row="${i}" data-field="disabled" ${row.disabled ? '' : 'checked'} title="启用/禁用"></div>
      <div class="kv-cell kv-key-wrap"><input class="kv-input" data-row="${i}" data-field="key" value="${esc(row.key || '')}" placeholder="Key">${typeSel}</div>
      <div class="kv-cell kv-value-wrap">${valueCell}</div>
      <button class="kv-del" data-del="${i}" title="删除">&times;</button>
    </div>`;
  }).join('');
  root.innerHTML = `<div class="kv-table">${head}${body || '<div class="kv-empty">暂无数据</div>'}</div>
    <button class="btn btn-link btn-sm kv-add">+ 添加一行</button>`;

  const commit = () => { opts.onChange && opts.onChange(); };

  $$('[data-field]', root).forEach(el => {
    const handler = () => {
      const i = +el.dataset.row;
      const f = el.dataset.field;
      if (f === 'file') return; // 文件内容由下面的 FileReader 单独处理
      if (f === 'disabled') rows[i].disabled = !el.checked;
      else if (f === 'type') {
        rows[i].type = el.value;
        if (el.value === 'file' && !rows[i].fileName) rows[i].fileName = '';
        renderKV(selector, rows, opts); // 结构变化需要重绘
        commit();
        return;
      } else {
        rows[i][f] = el.value;
        // 用户在 Params 表里主动编辑了值：语义由当前值决定——
        // 有值就带 "="，清空就回到"默认不保留等号"，不再沿用 URL 里的显式等号标记。
        if (f === 'value' && opts.query) {
          rows[i].noEq = false;
          rows[i].explicitEq = false;
        }
      }
      el.closest('.kv-row')?.classList.toggle('disabled', !!rows[i].disabled);
      commit();
    };
    if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'file') el.addEventListener('change', handler);
    else el.addEventListener('input', handler);
    if (el.type === 'file') {
      el.addEventListener('change', () => {
        const file = el.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          rows[+el.dataset.row].fileName = file.name;
          rows[+el.dataset.row].fileData = String(reader.result).split(',')[1] || '';
          rows[+el.dataset.row].type = 'file';
          renderKV(selector, rows, opts);
          commit();
        };
        reader.readAsDataURL(file);
      });
    }
  });
  $$('[data-del]', root).forEach(btn => btn.onclick = () => {
    rows.splice(+btn.dataset.del, 1);
    renderKV(selector, rows, opts);
    commit();
  });
  $('.kv-add', root).onclick = () => {
    rows.push({ key: '', value: '', disabled: false, type: 'text' });
    renderKV(selector, rows, opts);
    commit();
  };
}

// ---------------------------------------------------------------- 渲染：响应
function renderEmptyResponse() {
  $('#resp-summary').innerHTML = '<span class="muted">尚未发送请求</span>';
  $('#pretty-view').innerHTML = '<code></code>';
  $('#raw-view').textContent = '';
  $('#resp-headers-view').innerHTML = '<div class="empty-state">发送请求后可查看响应头</div>';
  $('#resp-cookies-view').innerHTML = '<div class="empty-state">发送请求后可查看 Cookies</div>';
  $('#resp-tests-view').innerHTML = '<div class="empty-state">在 Tests 中编写断言，发送后这里会显示结果</div>';
  $('#resp-request-view').innerHTML = '<div class="empty-state">发送请求后可查看实际发出的请求</div>';
  $('#response-meta').textContent = '';
  $('#preview-frame').srcdoc = '<div class="empty-state">HTML 响应会在这里预览</div>';
  $('#count-resp-headers').textContent = '';
  $('#count-resp-cookies').textContent = '';
  $('#count-resp-tests').textContent = '';
  state.respBody = null;
  if (state.respSearch.open) applyRespSearch({ reset: true });
}

function highlight(text, lang) {
  if (lang === 'json') return highlightJSON(text);
  if (lang === 'xml' || lang === 'html') return highlightMarkup(text);
  return esc(text);
}

function highlightJSON(s) {
  const re = /("(?:\\.|[^"\\])*"\s*:?)|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false)\b|\b(null)\b|([{}\[\],:])/g;
  let out = '', last = 0, m;
  while ((m = re.exec(s)) !== null) {
    out += esc(s.slice(last, m.index));
    if (m[1]) out += `<span class="${/:\s*$/.test(m[1]) ? 'tok-key' : 'tok-str'}">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-num">${esc(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-bool">${esc(m[3])}</span>`;
    else if (m[4]) out += `<span class="tok-null">${esc(m[4])}</span>`;
    else out += `<span class="tok-punct">${esc(m[5])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(s.slice(last));
}

function highlightMarkup(s) {
  return esc(s).replace(/(&lt;\/?)([a-zA-Z][\w:-]*)([^&]*?)(\/?&gt;)/g, (all, open, tag, attrs, close) => {
    const coloredAttrs = attrs.replace(/([\w:-]+)=/g, '<span class="tok-attr">$1</span>=');
    return `<span class="tok-punct">${open}</span><span class="tok-tag">${tag}</span>${coloredAttrs}<span class="tok-punct">${close}</span>`;
  });
}

function responseLang(resp, bodyText) {
  const forced = $('#pretty-lang').value;
  if (forced !== 'auto') return forced;
  const ct = (resp.contentType || '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml') || ct.includes('svg')) return 'xml';
  if (ct.includes('html')) return 'html';
  const t = (bodyText || '').trim();
  if ((t.startsWith('{') || t.startsWith('[')) && isJSON(t)) return 'json';
  if (t.startsWith('<')) return 'xml';
  return 'text';
}
function isJSON(s) { try { JSON.parse(s); return true; } catch (_) { return false; } }

function prettyText(text, lang) {
  if (lang === 'json' && isJSON(text)) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_) { /* fallthrough */ }
  }
  return text;
}

function renderResponse(resp, tests) {
  if (!resp) { renderEmptyResponse(); return; }
  const bodyText = resp.bodyBase64 ? '(二进制内容，请切换到 Raw 查看 base64 或点击下载)' : (resp.body || '');
  const lang = responseLang(resp, bodyText);
  const shown = prettyText(bodyText, lang);
  const rawText = resp.bodyBase64 ? '[base64]\n' + resp.body : bodyText;
  // 查找功能需要原始文本（搜索基于显示出来的内容，而不是被高亮拆散的 DOM）
  state.respBody = { pretty: shown, raw: rawText, lang };
  $('#pretty-view').innerHTML = '<code>' + highlight(shown, lang) + '</code>';
  $('#raw-view').textContent = rawText;
  $('#response-meta').textContent = `${resp.contentType || '未知类型'} · ${fmtBytes(resp.size)}${resp.truncated ? ' · 已截断' : ''}`;

  const statusClass = resp.statusCode >= 500 ? 's-5' : resp.statusCode >= 400 ? 's-4' : resp.statusCode >= 300 ? 's-3' : resp.statusCode >= 200 ? 's-2' : 's-err';
  $('#resp-summary').innerHTML = resp.ok
    ? `<span class="status-pill ${statusClass}">${esc(resp.status)}</span>
       <span class="metric">耗时 <b>${resp.timeMs} ms</b></span>
       <span class="metric">大小 <b>${fmtBytes(resp.size)}</b></span>
       ${resp.redirects?.length ? `<span class="metric">重定向 <b>${resp.redirects.length}</b></span>` : ''}`
    : `<span class="status-pill s-err">请求失败</span><span class="metric" style="color:var(--red)">${esc(resp.error || '未知错误')}</span>`;

  const rows = (obj) => Object.entries(obj || {}).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `<div class="kv-view-row"><div class="k">${esc(k)}</div><div class="v">${esc(Array.isArray(v) ? v.join('; ') : v)}</div></div>`).join('');
  $('#resp-headers-view').innerHTML = `<div class="kv-view-title">响应头 (${Object.keys(resp.headers || {}).length})</div>${rows(resp.headers) || '<div class="empty-state">无响应头</div>'}`;
  $('#count-resp-headers').textContent = Object.keys(resp.headers || {}).length || '';

  const cookies = resp.cookies || [];
  $('#resp-cookies-view').innerHTML = `<div class="kv-view-title">Set-Cookie (${cookies.length}) · 后续请求会自动携带</div>` +
    (cookies.map(c => `<div class="kv-view-row"><div class="k">${esc(c.name)}</div><div class="v">${esc(c.value)}${c.path ? ` · Path=${esc(c.path)}` : ''}${c.httpOnly ? ' · HttpOnly' : ''}${c.secure ? ' · Secure' : ''}</div></div>`).join('') || '<div class="empty-state">本次响应没有下发 Cookie</div>');
  $('#count-resp-cookies').textContent = cookies.length || '';

  const results = tests || [];
  $('#resp-tests-view').innerHTML = `<div class="kv-view-title">${results.filter(t => t.passed).length} 通过 / ${results.filter(t => !t.passed).length} 失败</div>` +
    (results.map(t => `<div class="test-row ${t.passed ? 'test-pass' : 'test-fail'}">
      <div class="test-name">${t.passed ? '通过' : '失败'} · ${esc(t.name)}</div>
      ${t.error ? `<div class="test-detail">${esc(t.error)}</div>` : ''}</div>`).join('') || '<div class="empty-state">本次没有执行断言</div>');
  $('#count-resp-tests').textContent = results.length ? `${results.filter(t => t.passed).length}/${results.length}` : '';

  $('#resp-request-view').innerHTML = `
    <div class="kv-view-title">实际发出的请求</div>
    <div class="kv-view-row"><div class="k">Method</div><div class="v">${esc(resp.method || '')}</div></div>
    <div class="kv-view-row"><div class="k">Final URL</div><div class="v">${esc(resp.finalURL || '')}</div></div>
    <div class="kv-view-title">请求头</div>${rows(resp.requestHeaders)}
    ${resp.redirects?.length ? `<div class="kv-view-title">重定向链</div>` + resp.redirects.map(h => `<div class="kv-view-row"><div class="k">${esc(h.from)}</div><div class="v">${esc(h.to)}</div></div>`).join('') : ''}`;

  $('#preview-frame').srcdoc = resp.bodyBase64
    ? '<div class="empty-state">二进制响应无法预览</div>'
    : (bodyText || '<div class="empty-state">空响应</div>');

  // 有新的响应内容时，如果查找条开着，重新算一遍命中
  if (state.respSearch.open) applyRespSearch({ reset: true });
}

// ---------------------------------------------------------------- 响应体查找
// 查找跑在"显示出来的文本"上，而不是高亮后的 DOM：JSON 的语法高亮会把内容拆成
// 很多 <span>，直接在 DOM 里找会漏掉跨标签的匹配。
// 优先用 CSS Custom Highlight API（Range 可跨节点、不改 DOM，语法着色保持原样）；
// 浏览器不支持时退化为纯文本 + <mark> 重渲染，关闭查找后恢复语法高亮。
const RESP_HIT = 'resp-hit';
const RESP_HIT_CURRENT = 'resp-hit-current';

function supportsRespHits() {
  return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
}

// 查找只作用于响应体；Headers / Cookies 等结构化面板不参与
function respSearchTarget() {
  if (state.respTab === 'raw') return $('#raw-view');
  if (state.respTab === 'pretty') return $('#pretty-view');
  return null;
}

function rangeFromOffsets(segs, start, end) {
  const locate = (off) => {
    for (let i = segs.length - 1; i >= 0; i--) {
      if (off >= segs[i].start) {
        return { node: segs[i].node, offset: Math.min(off - segs[i].start, segs[i].node.nodeValue.length) };
      }
    }
    return { node: segs[0].node, offset: 0 };
  };
  const a = locate(start), b = locate(end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

function collectRespHits(root, term) {
  if (!root || !term) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segs = [];
  let total = 0, node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (!len) continue;
    segs.push({ node, start: total });
    total += len;
  }
  if (!segs.length) return [];
  const hay = segs.map(s => s.node.nodeValue).join('').toLowerCase();
  const needle = term.toLowerCase();
  const hits = [];
  let at = hay.indexOf(needle);
  while (at !== -1) {
    hits.push(rangeFromOffsets(segs, at, at + needle.length));
    at = hay.indexOf(needle, at + needle.length);
  }
  return hits;
}

function updateRespSearchCount() {
  const s = state.respSearch;
  const el = $('#resp-search-count');
  if (!el) return;
  if (!s.term) { el.textContent = '0/0'; el.classList.remove('no-hit'); return; }
  el.textContent = s.total ? `${s.index + 1}/${s.total}` : '0/0';
  el.classList.toggle('no-hit', s.total === 0);
}

function clearRespHits() {
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete(RESP_HIT);
    CSS.highlights.delete(RESP_HIT_CURRENT);
  }
}

// 命中数量可能极大，new Highlight(...ranges) 是一次展开调用，这里兜一层底：
// 失败就放弃整体高亮，但计数和跳转仍可用，不至于把页面搞崩。
function setRespHits(name, ranges) {
  if (!ranges.length) return;
  try { CSS.highlights.set(name, new Highlight(...ranges)); }
  catch (_) { /* 忽略：命中过多时只是没有底色 */ }
}

// 退出查找时把视图恢复成带语法高亮的原样（仅在降级模式下需要）
function restoreRespViews() {
  const body = state.respBody;
  if (!body) return;
  $('#pretty-view').innerHTML = '<code>' + highlight(body.pretty, body.lang) + '</code>';
  $('#raw-view').textContent = body.raw;
}

// 纯文本兜底：返回高亮后的 HTML 与命中总数
function markPlainText(text, term, currentIndex) {
  const hay = text.toLowerCase(), needle = term.toLowerCase();
  let out = '', last = 0, at = 0, n = 0;
  while ((at = hay.indexOf(needle, last)) !== -1) {
    out += esc(text.slice(last, at));
    out += `<mark class="resp-hit${n === currentIndex ? ' current' : ''}">${esc(text.slice(at, at + needle.length))}</mark>`;
    last = at + needle.length;
    n++;
  }
  return { html: out + esc(text.slice(last)), count: n };
}

// 把"当前命中"标出来并滚到可视区域
function focusRespHit() {
  const s = state.respSearch;
  if (!s.open || !s.total) return;
  if (supportsRespHits() && s.ranges.length) {
    setRespHits(RESP_HIT_CURRENT, [s.ranges[s.index]]);
    const range = s.ranges[s.index];
    const el = range.startContainer.parentElement || range.startContainer;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
    return;
  }
  const marks = $$('mark.resp-hit');
  marks.forEach((m, i) => m.classList.toggle('current', i === s.index));
  const cur = marks[s.index];
  if (cur && typeof cur.scrollIntoView === 'function') cur.scrollIntoView({ block: 'center' });
}

function applyRespSearch({ reset = false } = {}) {
  const s = state.respSearch;
  const target = respSearchTarget();
  clearRespHits();

  if (!s.open || !s.term || !target) {
    if (s.fallback) { restoreRespViews(); s.fallback = false; }
    s.total = 0; s.index = 0; s.ranges = [];
    updateRespSearchCount();
    return;
  }

  if (supportsRespHits()) {
    if (s.fallback) { restoreRespViews(); s.fallback = false; }
    s.ranges = collectRespHits(target, s.term);
    s.total = s.ranges.length;
    if (reset || s.index >= s.total) s.index = 0;
    if (s.total) {
      setRespHits(RESP_HIT, s.ranges);
      setRespHits(RESP_HIT_CURRENT, [s.ranges[s.index]]);
    }
  } else {
    const body = state.respBody;
    if (!body) { s.total = 0; updateRespSearchCount(); return; }
    const isRaw = state.respTab === 'raw';
    const text = isRaw ? body.raw : body.pretty;
    const scrollTop = target.scrollTop;
    const marked = markPlainText(text, s.term, -1);
    s.total = marked.count;
    if (reset || s.index >= s.total) s.index = 0;
    target.innerHTML = isRaw ? marked.html : '<code>' + marked.html + '</code>';
    if (typeof target.scrollTop === 'number') target.scrollTop = scrollTop;
    s.fallback = true;
  }
  updateRespSearchCount();
  focusRespHit();
}

function stepRespSearch(delta) {
  const s = state.respSearch;
  if (!s.open || !s.total) return;
  s.index = (s.index + delta + s.total) % s.total;
  updateRespSearchCount();
  focusRespHit();
}

function openRespSearch() {
  const s = state.respSearch;
  s.open = true;
  $('#resp-search').classList.remove('hidden');
  const input = $('#resp-search-input');
  input.focus();
  input.select();
  if (s.term) applyRespSearch({ reset: true });
  else updateRespSearchCount();
}

function closeRespSearch() {
  const s = state.respSearch;
  s.open = false; s.term = ''; s.index = 0;
  $('#resp-search').classList.add('hidden');
  const input = $('#resp-search-input');
  if (input) input.value = '';
  applyRespSearch();
}

let respSearchTimer = 0;
function scheduleRespSearch(value) {
  state.respSearch.term = value;
  clearTimeout(respSearchTimer);
  respSearchTimer = setTimeout(() => applyRespSearch({ reset: true }), 120);
}

// ---------------------------------------------------------------- 脚本引擎
function makeAssert() {
  const fail = (msg) => { throw new Error(msg); };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function expect(actual) {
    const chain = {
      to: {
        eql: (exp) => { if (!eq(actual, exp)) fail(`期望 ${JSON.stringify(exp)}，实际 ${JSON.stringify(actual)}`); },
        equal: (exp) => { if (actual !== exp) fail(`期望 ${JSON.stringify(exp)}，实际 ${JSON.stringify(actual)}`); },
        be: {
          a: (type) => { if (typeof actual !== type && !(type === 'array' && Array.isArray(actual))) fail(`期望类型 ${type}`); },
          ok: { get() { if (!actual) fail('期望为真值'); } },
          true: { get() { if (actual !== true) fail('期望 true'); } },
          false: { get() { if (actual !== false) fail('期望 false'); } },
          above: (n) => { if (!(actual > n)) fail(`期望 > ${n}，实际 ${actual}`); },
          below: (n) => { if (!(actual < n)) fail(`期望 < ${n}，实际 ${actual}`); },
        },
        have: {
          property: (p) => { if (actual == null || !(p in Object(actual))) fail(`缺少属性 ${p}`); },
          length: (n) => { if (!actual || actual.length !== n) fail(`期望长度 ${n}`); },
          lengthOf: (n) => { if (!actual || actual.length !== n) fail(`期望长度 ${n}`); },
          string: (s) => { if (!String(actual).includes(s)) fail(`未包含 ${s}`); },
          status: (code) => { if (Number(actual) !== Number(code)) fail(`期望状态码 ${code}，实际 ${actual}`); },
        },
        include: (s) => { if (!String(actual).includes(s)) fail(`未包含 ${s}`); },
        match: (re) => { if (!new RegExp(re).test(String(actual))) fail(`不匹配 ${re}`); },
      },
      not: {
        to: { eql: (exp) => { if (eq(actual, exp)) fail('期望不相等'); }, have: { property: (p) => { if (p in Object(actual)) fail(`不应包含属性 ${p}`); } } },
      },
    };
    // pm.response.to.have.status(200) 这类用法
    chain.to.have.status = chain.to.have.status;
    return chain;
  }
  return expect;
}

function runScript(code, phase, resp) {
  const results = [];
  if (!code || !code.trim() || !state.runScripts) return results;
  const vars = collectVars();
  const env = activeEnv();
  const setVar = (scope, key, value) => {
    const v = String(value);
    state.runtimeVars[key] = v;
    if (scope === 'environment' && env) {
      const row = env.values.find(x => x.key === key);
      if (row) row.value = v; else env.values.push({ key, value: v });
      saveSoon();
    } else if (scope === 'globals') {
      const row = state.ws.globals.find(x => x.key === key);
      if (row) row.value = v; else state.ws.globals.push({ key, value: v });
      saveSoon();
    }
    vars[key] = v;
  };
  const getVar = (key) => (key in vars ? vars[key] : undefined);
  const headers = resp?.headers || {};
  const pm = {
    environment: { get: getVar, set: (k, v) => setVar('environment', k, v), unset: (k) => { if (env) env.values = env.values.filter(x => x.key !== k); } },
    globals: { get: (k) => (state.ws.globals.find(x => x.key === k) || {}).value, set: (k, v) => setVar('globals', k, v), unset: (k) => { state.ws.globals = state.ws.globals.filter(x => x.key !== k); } },
    variables: { get: getVar, set: (k, v) => setVar('runtime', k, v), has: (k) => k in vars },
    collectionVariables: { get: getVar, set: (k, v) => setVar('runtime', k, v) },
    info: { eventName: phase, iteration: 0 },
    test: (name, fn) => {
      try { fn(); results.push({ name, passed: true }); }
      catch (e) { results.push({ name, passed: false, error: e.message }); }
    },
    expect: makeAssert(),
    response: {
      code: resp?.statusCode, status: resp?.status, responseTime: resp?.timeMs,
      headers: { get: (k) => (Object.entries(headers).find(([n]) => n.toLowerCase() === k.toLowerCase()) || [])[1] },
      text: () => resp?.body || '',
      json: () => JSON.parse(resp?.body || '{}'),
      to: {
        have: { status: (code) => makeAssert()(resp?.statusCode).to.have.status(code), header: (k) => { if (!headers[k]) throw new Error('缺少响应头 ' + k); } },
        be: { ok: { get() { if (!(resp?.statusCode >= 200 && resp?.statusCode < 300)) throw new Error('期望 2xx'); } }, success: { get() {} } },
      },
    },
    setNextRequest: () => {}, // 无 Collection Runner，安全忽略
  };
  const logs = [];
  const fakeConsole = { log: (...a) => logs.push(a.map(String).join(' ')), warn: (...a) => logs.push(a.map(String).join(' ')), error: (...a) => logs.push(a.map(String).join(' ')) };
  try {
    // 脚本来自用户本机工作区；可在设置中整体关闭执行。
    new Function('pm', 'console', 'responseBody', 'responseHeaders', code)(pm, fakeConsole, resp?.body, headers);
  } catch (e) {
    results.push({ name: phase === 'prerequest' ? 'Pre-request Script' : 'Tests 脚本执行异常', passed: false, error: e.message });
  }
  logs.forEach(l => results.push({ name: 'console: ' + l, passed: true }));
  return results;
}

// ---------------------------------------------------------------- 发送请求
async function sendRequest() {
  if (state.sending) return;
  const tab = activeTab();
  if (!tab) return;
  const r = tab.request = ensureRequest(tab.request);
  if (!r.url.trim()) { toast('请先输入 URL', 'error'); $('#url-input').focus(); return; }

  state.sending = true;
  const btn = $('#btn-send');
  btn.classList.add('loading');
  btn.disabled = true;
  btn.innerHTML = '发送中…';

  const preResults = runScript(r.preScript, 'prerequest', null);
  const preError = preResults.find(x => !x.passed);
  if (preError) { toast('Pre-request 脚本出错: ' + preError.error, 'error'); }

  const payload = {
    ...clone(r),
    options: {
      timeoutMs: state.ws.settings.timeoutMs,
      followRedirects: state.ws.settings.followRedirects,
      insecureSkipVerify: state.ws.settings.insecureSkipVerify,
      maxBodyBytes: state.ws.settings.maxBodyBytes,
    },
    variables: collectVars(),
  };
  try {
    await saveNow(); // 先落盘，避免历史记录被随后的防抖保存覆盖
    const resp = await api('/api/send', { method: 'POST', body: JSON.stringify(payload) });
    const testResults = [
      ...preResults,
      ...(resp.ok ? runScript(r.testScript, 'test', resp) : []),
    ];
    state.responses[tab.id] = { response: resp, tests: testResults };
    renderResponse(resp, testResults);
    switchRespTab(testResults.length ? 'tests' : 'pretty');
    const fresh = await api('/api/workspace');
    state.ws.history = fresh.history || [];
    renderHistory();
    if (!resp.ok) toast(resp.error || '请求失败', 'error');
  } catch (e) {
    toast('请求异常: ' + e.message, 'error');
  } finally {
    state.sending = false;
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.innerHTML = '发送 <kbd>Ctrl</kbd>+<kbd>↵</kbd>';
  }
}

// ---------------------------------------------------------------- 标签操作
function newTab(render = true, spec = null, meta = {}) {
  const tab = {
    id: uid('tab'), name: meta.name || '新请求',
    request: spec ? clone(spec) : emptyRequest(),
    savedId: meta.savedId, collectionId: meta.collectionId, folderId: meta.folderId,
    dirty: false,
  };
  state.ws.tabs.push(tab);
  state.activeTabId = tab.id;
  if (render) { renderTabs(); renderRequest(); saveSoon(); }
  return tab;
}

function closeTab(id) {
  const idx = state.ws.tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  state.ws.tabs.splice(idx, 1);
  delete state.responses[id];
  if (!state.ws.tabs.length) { newTab(false); }
  if (state.activeTabId === id) state.activeTabId = state.ws.tabs[Math.max(0, idx - 1)].id;
  renderTabs(); renderRequest(); saveSoon();
}

function openSavedItem(col, item) {
  const existing = state.ws.tabs.find(t => t.savedId === item.id);
  if (existing) { state.activeTabId = existing.id; }
  else newTab(true, item.request, { name: item.name, savedId: item.id, collectionId: col.id });
  renderTabs(); renderRequest(); renderCollections(); saveSoon();
}

function findItem(col, id, parent = null) {
  for (const it of col.items || []) {
    if (it.id === id) return { item: it, parent };
    if (it.items) { const found = findItem({ items: it.items }, id, it); if (found) return found; }
  }
  return null;
}

function removeItem(col, id) {
  const walk = (items) => items.filter(it => {
    if (it.id === id) return false;
    if (it.items) it.items = walk(it.items);
    return true;
  });
  col.items = walk(col.items || []);
}

// ---------------------------------------------------------------- 保存 / 新建
async function saveRequestDialog() {
  const tab = activeTab();
  const cols = state.ws.collections;
  let options = cols.map(c => `<option value="${esc(c.id)}" ${tab.collectionId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  if (!cols.length) options = '<option value="__new__">（新建集合）</option>';
  else options += '<option value="__new__">+ 新建集合…</option>';
  const defaultName = tab.savedId ? tab.name : (tab.request.url?.split('/').filter(Boolean).pop() || '新请求');
  openModal({
    title: '保存请求',
    body: `<div class="form-row"><label>请求名称</label><input class="input" id="save-name" value="${esc(defaultName)}"></div>
      <div class="form-row"><label>保存到集合</label><select class="select" id="save-col">${options}</select></div>
      <div class="form-row" id="folder-row"><label>文件夹（可选）</label><select class="select" id="save-folder"><option value="">集合根目录</option></select></div>
      <div class="info-box green">保存只写入本机数据文件，不需要登录，也不会上传到任何服务器。</div>`,
    footer: `<button class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" id="save-confirm">保存</button>`,
    onMount(el, close) {
      const colSel = $('#save-col', el);
      const folderSel = $('#save-folder', el);
      const fillFolders = () => {
        const col = cols.find(c => c.id === colSel.value);
        const walk = (items, prefix = '') => (items || []).filter(i => i.type === 'folder').flatMap(f =>
          [{ id: f.id, name: prefix + f.name }, ...walk(f.items, prefix + f.name + ' / ')]);
        const list = col ? walk(col.items) : [];
        folderSel.innerHTML = '<option value="">集合根目录</option>' + list.map(f => `<option value="${esc(f.id)}" ${tab.folderId === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
      };
      fillFolders();
      colSel.onchange = fillFolders;
      $('#save-confirm', el).onclick = async () => {
        const name = $('#save-name', el).value.trim() || '未命名请求';
        let colId = colSel.value;
        if (colId === '__new__') {
          const cname = await promptModal('新建集合', '我的集合', '集合名称');
          if (!cname) return;
          const col = { id: uid('col'), name: cname, items: [], variables: [] };
          state.ws.collections.push(col);
          colId = col.id;
        }
        const col = state.ws.collections.find(c => c.id === colId);
        if (!col) return;
        col.items = col.items || [];
        const spec = clone(tab.request);
        const folderId = folderSel.value;
        const target = folderId ? (findItem(col, folderId)?.item) : null;
        const arr = target ? (target.items = target.items || []) : col.items;
        if (tab.savedId) {
          const found = findItem(col, tab.savedId);
          if (found) {
            Object.assign(found.item, { name, request: spec });
          } else arr.push({ id: uid('req'), name, type: 'request', request: spec });
        } else {
          const id = uid('req');
          arr.push({ id, name, type: 'request', request: spec });
          tab.savedId = id;
        }
        tab.collectionId = colId;
        tab.folderId = folderId || undefined;
        tab.name = name;
        tab.dirty = false;
        close();
        await saveNow();
        renderAll();
        toast('请求已保存到本机', 'success');
      };
    },
  });
}

async function newCollectionDialog() {
  const name = await promptModal('新建集合', '新建集合', '集合名称');
  if (!name) return;
  state.ws.collections.push({ id: uid('col'), name, items: [], variables: [] });
  saveSoon(); renderCollections(); toast('集合已创建', 'success');
}

async function newFolderDialog(colId) {
  const col = state.ws.collections.find(c => c.id === colId);
  if (!col) return;
  const name = await promptModal('新建文件夹', '新建文件夹', '文件夹名称');
  if (!name) return;
  col.items = col.items || [];
  col.items.push({ id: uid('folder'), name, type: 'folder', items: [] });
  saveSoon(); renderCollections();
}

// ---------------------------------------------------------------- 环境 / 变量管理
function envRowsModal(targetId) {
  const rows = targetId === '__globals__' ? state.ws.globals : (state.ws.environments.find(e => e.id === targetId)?.values || []);
  const root = $('#env-rows');
  renderKV('#env-rows', rows, {
    key: '变量名', value: '变量值',
    onChange: () => { renderEnvSelect(); renderUrlHint(); saveSoon(); },
  });
}

function openVarsModal(startId) {
  let current = startId || state.ws.activeEnvId || '__globals__';
  const body = `
    <div class="form-row"><label>编辑对象</label><select class="select" id="vars-target"></select></div>
    <div class="side-toolbar">
      <button class="btn btn-ghost btn-sm" id="vars-new">+ 新建环境</button>
      <button class="btn btn-ghost btn-sm" id="vars-rename">重命名</button>
      <button class="btn btn-danger btn-sm" id="vars-delete">删除环境</button>
    </div>
    <div id="env-rows"></div>
    <div class="info-box" style="margin-top:14px">
      变量优先级：脚本运行时 &gt; 当前环境 &gt; 集合变量 &gt; 全局变量。<br>
      在 URL、Header、Body 里用 <code>{{name}}</code> 引用。还支持动态变量
      <code>{{$timestamp}}</code>、<code>{{$guid}}</code>、<code>{{$randomInt}}</code>、<code>{{$isotimestamp}}</code>。<br>
      <b>base_url 留空</b>表示相对路径自动指向本机服务，适合离线调试 /api/echo。
    </div>`;
  openModal({
    title: '环境与变量', body, wide: true,
    footer: '<button class="btn btn-primary" data-close>完成</button>',
    onMount(el, close) {
      const sel = $('#vars-target', el);
      const refresh = () => {
        sel.innerHTML = state.ws.environments.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('') +
          '<option value="__globals__">全局变量 (Globals)</option>';
        if (!state.ws.environments.some(e => e.id === current)) current = '__globals__';
        sel.value = current;
        envRowsModal(current);
        $('#vars-delete', el).disabled = current === '__globals__';
        $('#vars-rename', el).disabled = current === '__globals__';
      };
      refresh();
      sel.onchange = () => { current = sel.value; refresh(); };
      const createEnv = async () => {
        const name = await promptModal('新建环境', 'Dev', '环境名称');
        if (!name) return;
        const env = { id: uid('env'), name, values: [] };
        state.ws.environments.push(env);
        current = env.id;
        state.ws.activeEnvId = env.id;
        renderEnvSelect(); renderEnvList(); refresh(); saveSoon();
      };
      $('#vars-new', el).onclick = createEnv;
      if (startId === '__new__') setTimeout(createEnv, 0);
      $('#vars-rename', el).onclick = async () => {
        const env = state.ws.environments.find(e => e.id === current);
        if (!env) return;
        const name = await promptModal('重命名环境', env.name, '环境名称');
        if (!name) return;
        env.name = name;
        renderEnvSelect(); renderEnvList(); refresh(); saveSoon();
      };
      $('#vars-delete', el).onclick = async () => {
        if (!await confirmModal('删除环境', '确定删除这个环境及其所有变量？此操作不可撤销。')) return;
        state.ws.environments = state.ws.environments.filter(e => e.id !== current);
        if (state.ws.activeEnvId === current) state.ws.activeEnvId = state.ws.environments[0]?.id || '';
        current = state.ws.activeEnvId || '__globals__';
        renderEnvSelect(); renderEnvList(); refresh(); saveSoon();
      };
    },
  });
}

// ---------------------------------------------------------------- 导入 / 导出
function openImportModal() {
  const body = `
    <div class="modal-tabs">
      <button class="modal-tab active" data-imptab="postman">Postman 集合 / 环境</button>
      <button class="modal-tab" data-imptab="curl">cURL 命令</button>
      <button class="modal-tab" data-imptab="workspace">GoPostman 工作区</button>
    </div>
    <div data-impbody="postman">
      <div class="info-box green">直接粘贴从 Postman 导出的 Collection v2.1 或 Environment JSON。全程在本机解析，不需要 Postman 账号。</div>
      <div class="side-toolbar"><input type="file" id="import-file" accept=".json,application/json"></div>
      <textarea class="code-area" id="import-postman-text" placeholder='{ "info": { "name": "My API" }, "item": [...] }'></textarea>
    </div>
    <div data-impbody="curl" class="hidden">
      <div class="info-box">粘贴一条 curl 命令，会自动还原 method / headers / body / 认证。</div>
      <textarea class="code-area" id="import-curl-text" placeholder="curl -X POST https://api.example.com/items -H 'Content-Type: application/json' -d '{&quot;name&quot;:&quot;test&quot;}'"></textarea>
    </div>
    <div data-impbody="workspace" class="hidden">
      <div class="info-box">导入之前导出的完整工作区文件。<b>会覆盖当前所有集合、环境和历史</b>。</div>
      <div class="side-toolbar"><input type="file" id="import-ws-file" accept=".json,application/json"></div>
      <textarea class="code-area" id="import-ws-text" placeholder="粘贴 GoPostman 工作区 JSON"></textarea>
    </div>`;
  openModal({
    title: '导入', body, wide: true,
    footer: `<button class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" id="import-ok">导入</button>`,
    onMount(el, close) {
      let tab = 'postman';
      const switchTab = (t) => {
        tab = t;
        $$('.modal-tab', el).forEach(b => b.classList.toggle('active', b.dataset.imptab === t));
        $$('[data-impbody]', el).forEach(b => b.classList.toggle('hidden', b.dataset.impbody !== t));
      };
      $$('.modal-tab', el).forEach(b => b.onclick = () => switchTab(b.dataset.imptab));
      const readFile = (input, textarea) => input.addEventListener('change', () => {
        const f = input.files[0]; if (!f) return;
        const reader = new FileReader();
        reader.onload = () => { textarea.value = String(reader.result); toast('文件已读取，点「导入」继续'); };
        reader.readAsText(f);
      });
      readFile($('#import-file', el), $('#import-postman-text', el));
      readFile($('#import-ws-file', el), $('#import-ws-text', el));

      $('#import-ok', el).onclick = async () => {
        if (tab === 'postman') {
          const content = $('#import-postman-text', el).value.trim();
          if (!content) return toast('请先粘贴 JSON 或选择文件', 'error');
          const r = await api('/api/import/postman', { method: 'POST', body: JSON.stringify({ content }) });
          if (!r.ok) return toast(r.error || '导入失败', 'error');
          state.ws.collections.push(...(r.collections || []));
          state.ws.environments.push(...(r.environments || []));
          close(); await saveNow(); renderAll();
          toast(`已导入 ${r.collections?.length || 0} 个集合、${r.environments?.length || 0} 个环境`, 'success');
        } else if (tab === 'curl') {
          const command = $('#import-curl-text', el).value.trim();
          if (!command) return toast('请先粘贴 curl 命令', 'error');
          const r = await api('/api/parse/curl', { method: 'POST', body: JSON.stringify({ command }) });
          if (!r.ok) return toast(r.error || '解析失败', 'error');
          newTab(true, r.request, { name: nonEmpty(r.request.url?.split('/').filter(Boolean).pop(), 'cURL 请求') });
          close(); toast('cURL 已还原为请求', 'success');
        } else {
          const text = $('#import-ws-text', el).value.trim();
          if (!text) return toast('请先粘贴工作区 JSON', 'error');
          let ws;
          try { ws = JSON.parse(text); } catch (e) { return toast('JSON 解析失败: ' + e.message, 'error'); }
          if (!Array.isArray(ws.collections) || !Array.isArray(ws.tabs)) return toast('不是有效的 GoPostman 工作区文件', 'error');
          if (!await confirmModal('覆盖工作区', '导入会覆盖当前所有数据，确定继续？')) return;
          state.ws = ws;
          state.activeTabId = ws.activeTabId || ws.tabs[0]?.id;
          state.responses = {};
          close(); await saveNow(); renderAll(); toast('工作区已恢复', 'success');
        }
      };
    },
  });
}

function toPostmanCollection(col) {
  const convertAuth = (a) => {
    if (!a) return undefined;
    if (a.type === 'bearer') return { type: 'bearer', bearer: [{ key: 'token', value: a.bearer || '', type: 'string' }] };
    if (a.type === 'basic') return { type: 'basic', basic: [{ key: 'username', value: a.username || '', type: 'string' }, { key: 'password', value: a.password || '', type: 'string' }] };
    if (a.type === 'apikey') return { type: 'apikey', apikey: [{ key: 'key', value: a.apiKeyKey || '' }, { key: 'value', value: a.apiKeyValue || '' }, { key: 'in', value: a.apiKeyIn || 'header' }] };
    return undefined;
  };
  const convertBody = (b) => {
    if (!b || b.mode === 'none') return undefined;
    if (b.mode === 'raw') return { mode: 'raw', raw: b.raw || '', options: { raw: { language: b.rawLang || 'text' } } };
    if (b.mode === 'urlencoded') return { mode: 'urlencoded', urlencoded: (b.urlEncoded || []).map(k => ({ key: k.key, value: k.value, disabled: !!k.disabled })) };
    if (b.mode === 'formdata') return { mode: 'formdata', formdata: (b.formData || []).map(k => ({ key: k.key, value: k.type === 'file' ? '' : k.value, src: k.type === 'file' ? k.fileName : undefined, type: k.type === 'file' ? 'file' : 'text', disabled: !!k.disabled })) };
    if (b.mode === 'graphql') return { mode: 'graphql', graphql: { query: b.graphqlQuery || '', variables: b.graphqlVariables || '{}' } };
    return undefined;
  };
  const convertItem = (it) => {
    if (it.type === 'folder') return { name: it.name, item: (it.items || []).map(convertItem) };
    const r = it.request || {};
    const events = [];
    if (r.preScript) events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: [r.preScript] } });
    if (r.testScript) events.push({ listen: 'test', script: { type: 'text/javascript', exec: [r.testScript] } });
    return {
      name: it.name,
      request: {
        method: r.method || 'GET',
        header: (r.headers || []).map(h => ({ key: h.key, value: h.value, disabled: !!h.disabled })),
        url: { raw: buildFullURL(r), query: (r.params || []).map(p => ({ key: p.key, value: p.value, disabled: !!p.disabled })) },
        body: convertBody(r.body), auth: convertAuth(r.auth), description: r.description || '',
      },
      event: events,
    };
  };
  return {
    info: { name: col.name, description: col.description || '', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: (col.items || []).map(convertItem),
    variable: (col.variables || []).map(v => ({ key: v.key, value: v.value, type: v.secret ? 'secret' : 'string', disabled: !!v.disabled })),
    auth: convertAuth(col.auth),
  };
}

function buildFullURL(r) {
  let u = r.url || '';
  const { hash } = splitURL(u);
  if (hash) u = u.slice(0, -hash.length);
  const extras = [];
  // 联动之后 URL 已含 Params；只有旧数据（URL 无 query 而 Params 有值）才补一次
  if (!u.includes('?')) {
    (r.params || []).filter(p => !p.disabled && p.key).forEach(p => extras.push(paramPair(p)));
  }
  if (r.auth?.type === 'apikey' && r.auth.apiKeyIn === 'query' && r.auth.apiKeyKey) {
    extras.push(rawQueryPart(r.auth.apiKeyKey) + '=' + rawQueryPart(r.auth.apiKeyValue));
  }
  if (extras.length) {
    const sep = u.includes('?') ? (u.endsWith('?') || u.endsWith('&') ? '' : '&') : '?';
    u += sep + extras.join('&');
  }
  return u + hash; // 导出保留原始 URL，编码只在发请求时做
}

function toPostmanEnvironment(env, isGlobal = false) {
  return {
    id: env.id, name: env.name,
    values: (isGlobal ? state.ws.globals : env.values || []).map(v => ({ key: v.key, value: v.value, enabled: !v.disabled, type: v.secret ? 'secret' : 'default' })),
    _postman_variable_scope: isGlobal ? 'globals' : 'environment',
  };
}

function openExportModal() {
  const tab = activeTab();
  const cols = state.ws.collections;
  const body = `
    <div class="info-box green">所有导出都在浏览器本地完成，不经过任何服务器，也不需要登录。</div>
    <div class="form-row"><label>完整工作区</label><span class="muted">集合 + 环境 + 历史 + 标签，可用于备份或换机器迁移</span></div>
    <div class="form-row"><label>&nbsp;</label><button class="btn btn-ghost btn-sm" id="exp-workspace">下载 GoPostman JSON</button></div>
    <div class="modal-section-title">导出为 Postman 格式</div>
    <div class="form-row"><label>选择集合</label><select class="select" id="exp-col">${cols.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('') || '<option value="">（暂无集合）</option>'}</select></div>
    <div class="form-row"><label>&nbsp;</label><button class="btn btn-ghost btn-sm" id="exp-postman">下载 Collection v2.1</button>
      <button class="btn btn-ghost btn-sm" id="exp-env">下载当前环境</button></div>
    <div class="modal-section-title">当前请求</div>
    <div class="form-row"><label>&nbsp;</label><button class="btn btn-ghost btn-sm" id="exp-curl">复制为 cURL</button>
      <button class="btn btn-ghost btn-sm" id="exp-request">下载请求 JSON</button></div>`;
  openModal({
    title: '导出', body,
    footer: '<button class="btn btn-primary" data-close>完成</button>',
    onMount(el, close) {
      const stamp = () => new Date().toISOString().slice(0, 10);
      $('#exp-workspace', el).onclick = () => {
        download(`gopostman-workspace-${stamp()}.json`, JSON.stringify(state.ws, null, 2));
        toast('工作区已导出', 'success');
      };
      $('#exp-postman', el).onclick = () => {
        const col = cols.find(c => c.id === $('#exp-col', el).value);
        if (!col) return toast('请先创建集合', 'error');
        download(`${col.name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}.postman_collection.json`, JSON.stringify(toPostmanCollection(col), null, 2));
        toast('集合已导出为 Postman v2.1', 'success');
      };
      $('#exp-env', el).onclick = () => {
        const env = activeEnv() || { id: 'globals', name: 'Globals' };
        download(`${env.name}.postman_environment.json`, JSON.stringify(toPostmanEnvironment(env, !activeEnv()), null, 2));
        toast('环境已导出', 'success');
      };
      $('#exp-curl', el).onclick = async () => {
        const r = await api('/api/export/curl', { method: 'POST', body: JSON.stringify(tab.request) });
        if (r.ok && await copyText(r.command)) toast('cURL 已复制到剪贴板', 'success');
        else toast('复制失败', 'error');
      };
      $('#exp-request', el).onclick = () => {
        download('request.json', JSON.stringify(tab.request, null, 2));
        toast('请求已导出', 'success');
      };
    },
  });
}

// ---------------------------------------------------------------- 设置
function openSettingsModal() {
  const s = state.ws.settings;
  const body = `
    <div class="form-row"><label>请求超时 (ms)</label><input class="input" id="set-timeout" type="number" min="0" value="${s.timeoutMs ?? 0}"></div>
    <div class="form-hint">填 0 或留空表示<b>不限制超时</b>；填写正数则按毫秒生效。</div>
    <div class="form-row"><label>最大响应体 (字节)</label><input class="input" id="set-maxbody" type="number" min="1024" value="${s.maxBodyBytes || 8388608}"></div>
    <div class="form-row"><label>跟随重定向</label><label class="checkbox-label"><input type="checkbox" id="set-redirect" ${s.followRedirects ? 'checked' : ''}> 自动跟随 3xx（最多 10 跳）</label></div>
    <div class="form-row"><label>忽略 TLS 证书错误</label><label class="checkbox-label"><input type="checkbox" id="set-insecure" ${s.insecureSkipVerify ? 'checked' : ''}> 默认开启，方便自签名证书 / 内网测试；需要严格校验时可关闭</label></div>
    <div class="form-row"><label>保存请求历史</label><label class="checkbox-label"><input type="checkbox" id="set-history" ${s.saveHistory ? 'checked' : ''}> 自动记录每次发送</label></div>
    <div class="form-row"><label>历史上限 (条)</label><input class="input" id="set-historylimit" type="number" min="10" value="${s.historyLimit ?? 1000}"></div>
    <div class="form-row"><label>执行 Scripts 脚本</label><label class="checkbox-label"><input type="checkbox" id="set-scripts" ${state.runScripts ? 'checked' : ''}> Pre-request / Tests（导入的第三方集合请留意脚本内容）</label></div>
    <div class="modal-section-title">本机数据</div>
    <div class="info-box" id="set-datapath">读取中…</div>
    <div class="form-row"><label>&nbsp;</label><button class="btn btn-ghost btn-sm" id="set-clearcookies">清空 Cookie 罐</button>
      <button class="btn btn-danger btn-sm" id="set-clearhistory">清空历史</button></div>`;
  openModal({
    title: '设置', body,
    footer: `<button class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" id="set-save">保存设置</button>`,
    onMount(el, close) {
      api('/api/meta').then(m => { $('#set-datapath', el).textContent = `数据文件：${m.dataFile} · 登录要求：${m.authRequired ? '是' : '无'} · 云同步：${m.cloudSync ? '开启' : '关闭'}`; });
      $('#set-clearcookies', el).onclick = async () => {
        await api('/api/cookies', { method: 'DELETE' });
        toast('Cookie 已清空', 'success');
      };
      $('#set-clearhistory', el).onclick = async () => {
        if (!await confirmModal('清空历史', '确定删除所有历史记录？')) return;
        state.ws.history = [];
        await saveNow(); renderHistory(); toast('历史已清空');
      };
      $('#set-save', el).onclick = async () => {
        const timeoutVal = parseInt($('#set-timeout', el).value, 10);
        state.ws.settings = {
          // 0 / 空 / 非法值都表示不限制，不能回退成 30000
          timeoutMs: Number.isFinite(timeoutVal) && timeoutVal > 0 ? timeoutVal : 0,
          maxBodyBytes: +$('#set-maxbody', el).value || 8388608,
          followRedirects: $('#set-redirect', el).checked,
          insecureSkipVerify: $('#set-insecure', el).checked,
          saveHistory: $('#set-history', el).checked,
          historyLimit: +$('#set-historylimit', el).value || 1000,
          settingsVersion: 2,
        };
        state.runScripts = $('#set-scripts', el).checked;
        localStorage.setItem('gopostman.runScripts', String(state.runScripts));
        close(); await saveNow(); toast('设置已保存', 'success');
      };
    },
  });
}

// ---------------------------------------------------------------- 批量编辑
function openBulkEditor(title, rows, apply) {
  const text = (rows || []).filter(r => r.key || r.value).map(r => `${r.disabled ? '// ' : ''}${r.key}: ${r.value}`).join('\n');
  openModal({
    title, wide: true,
    body: `<div class="info-box">每行一条，格式为 <code>Key: Value</code>；行首加 <code>// </code> 表示禁用该行。</div>
      <textarea class="code-area bulk-editor" id="bulk-text">${esc(text)}</textarea>`,
    footer: `<button class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" id="bulk-apply">应用</button>`,
    onMount(el, close) {
      $('#bulk-apply', el).onclick = () => {
        const parsed = $('#bulk-text', el).value.split('\n').filter(l => l.trim()).map(line => {
          const disabled = line.trimStart().startsWith('// ');
          const body = disabled ? line.trimStart().slice(3) : line;
          const i = body.indexOf(':');
          return i < 0
            ? { key: body.trim(), value: '', disabled, type: 'text' }
            : { key: body.slice(0, i).trim(), value: body.slice(i + 1).trim(), disabled, type: 'text' };
        });
        apply(parsed);
        close();
      };
    },
  });
}

// ---------------------------------------------------------------- 面板切换
function switchReqTab(name) {
  state.reqTab = name;
  $$('#req-tabs .pane-tab').forEach(b => b.classList.toggle('active', b.dataset.reqtab === name));
  $$('#req-panels .req-panel').forEach(p => p.classList.toggle('hidden', p.dataset.reqpanel !== name));
}
function switchRespTab(name) {
  state.respTab = name;
  $$('#resp-tabs .pane-tab').forEach(b => b.classList.toggle('active', b.dataset.resptab === name));
  $$('#resp-panels .resp-panel').forEach(p => p.classList.toggle('hidden', p.dataset.resppanel !== name));
  // 查找只在 Pretty / Raw 生效，切标签后需要在新视图里重算
  if (state.respSearch.open) applyRespSearch({ reset: true });
}
function renderAll() {
  renderEnvSelect(); renderSidebar(); renderTabs(); renderRequest();
}

// ---------------------------------------------------------------- 事件绑定
function bindEvents() {
  // 顶栏
  $('#env-select').onchange = (e) => { state.ws.activeEnvId = e.target.value; renderEnvList(); renderUrlHint(); saveSoon(); };
  $('#btn-vars').onclick = () => openVarsModal();
  $('#btn-import').onclick = openImportModal;
  $('#btn-export').onclick = openExportModal;
  $('#btn-settings').onclick = openSettingsModal;

  // 侧栏
  $$('.sidebar-tab').forEach(b => b.onclick = () => { state.side = b.dataset.side; renderSidebar(); });
  $('#collection-search').oninput = (e) => { state.cSearch = e.target.value; renderCollections(); };
  $('#history-search').oninput = (e) => { state.hSearch = e.target.value; renderHistory(); };
  $('#btn-clear-history').onclick = async () => {
    if (!await confirmModal('清空历史', '确定删除所有历史记录？')) return;
    state.ws.history = []; await saveNow(); renderHistory();
  };
  $('#btn-new-collection').onclick = newCollectionDialog;
  $('#btn-new-folder').onclick = () => {
    const cols = state.ws.collections;
    if (!cols.length) return toast('请先创建一个集合', 'error');
    if (cols.length === 1) return newFolderDialog(cols[0].id);
    openModal({
      title: '在哪个集合新建文件夹',
      body: `<div class="form-row"><label>目标集合</label><select class="select" id="folder-target">${cols.map(c => `<option value="${esc(c.id)}" ${activeTab()?.collectionId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>`,
      footer: `<button class="btn btn-ghost" data-close>取消</button><button class="btn btn-primary" id="folder-ok">下一步</button>`,
      onMount(el, close) {
        $('#folder-ok', el).onclick = () => { const id = $('#folder-target', el).value; close(); newFolderDialog(id); };
      },
    });
  };
  $('#btn-new-env').onclick = () => openVarsModal('__new__');
  $('#btn-new-tab').onclick = () => newTab();

  // 集合树（事件委托）
  $('#collection-tree').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-toggle-col], [data-toggle], [data-col-add], [data-col-folder], [data-col-export], [data-col-rename], [data-col-delete], [data-folder-add], [data-item-rename], [data-item-delete], [data-item-dup], [data-open]');
    const colIdFrom = (attr) => btn?.getAttribute(attr)?.split('|')[0];
    const d = btn?.dataset || {};
    if (d.toggleCol) { toggleCollapse(d.toggleCol); return; }
    if (d.toggle) { toggleCollapse(d.toggle); return; }
    if (d.open) {
      const [colId, itemId] = d.open.split('|');
      const col = state.ws.collections.find(c => c.id === colId);
      const found = col && findItem(col, itemId);
      if (found) openSavedItem(col, found.item);
      return;
    }
    if (d.colAdd) {
      const col = state.ws.collections.find(c => c.id === d.colAdd);
      const tab = newTab(false);
      tab.collectionId = col.id;
      tab.name = '新请求';
      renderTabs(); renderRequest(); saveSoon();
      return;
    }
    if (d.folderAdd) {
      const [colId, folderId] = d.folderAdd.split('|');
      const tab = newTab(false);
      tab.collectionId = colId; tab.folderId = folderId;
      renderTabs(); renderRequest(); saveSoon();
      state.collapsed.delete(folderId); renderCollections();
      return;
    }
    if (d.colFolder) return newFolderDialog(d.colFolder);
    if (d.colExport) {
      const col = state.ws.collections.find(c => c.id === d.colExport);
      if (col) download(`${col.name}.postman_collection.json`, JSON.stringify(toPostmanCollection(col), null, 2));
      return;
    }
    if (d.colRename) {
      const col = state.ws.collections.find(c => c.id === d.colRename);
      const name = await promptModal('重命名集合', col.name, '集合名称');
      if (name) { col.name = name; saveSoon(); renderCollections(); }
      return;
    }
    if (d.colDelete) {
      const col = state.ws.collections.find(c => c.id === d.colDelete);
      if (await confirmModal('删除集合', `确定删除「${col.name}」及其中的所有请求？`)) {
        state.ws.collections = state.ws.collections.filter(c => c.id !== d.colDelete);
        saveSoon(); renderCollections();
      }
      return;
    }
    if (d.itemRename || d.itemDelete || d.itemDup) {
      const id = d.itemRename || d.itemDelete || d.itemDup;
      const colId = colIdFrom('data-item-rename') || colIdFrom('data-item-delete') || colIdFrom('data-item-dup');
      const col = state.ws.collections.find(c => c.id === colId);
      const found = col && findItem(col, id.split('|')[1]);
      if (!found) return;
      if (d.itemRename) {
        const name = await promptModal('重命名', found.item.name, '名称');
        if (name) { found.item.name = name; saveSoon(); renderCollections(); }
      } else if (d.itemDelete) {
        if (await confirmModal('删除', `确定删除「${found.item.name}」？`)) { removeItem(col, id.split('|')[1]); saveSoon(); renderCollections(); }
      } else {
        const copy = clone(found.item);
        copy.id = uid('req'); copy.name += ' 副本';
        const arr = found.parent ? (found.parent.items = found.parent.items || []) : col.items;
        arr.push(copy); saveSoon(); renderCollections();
      }
    }
  });

  // 历史
  $('#history-list').onclick = (e) => {
    const el = e.target.closest('[data-history]');
    if (!el) return;
    const h = state.ws.history.find(x => x.id === el.dataset.history);
    if (h) newTab(true, h.request, { name: h.url?.split('/').filter(Boolean).pop() || h.method });
  };
  // 环境列表
  $('#env-list').onclick = (e) => {
    const el = e.target.closest('[data-env]');
    if (!el) return;
    if (el.dataset.env === state.ws.activeEnvId) return openVarsModal(el.dataset.env);
    state.ws.activeEnvId = el.dataset.env;
    renderEnvSelect(); renderEnvList(); renderUrlHint(); saveSoon();
    toast('已切换环境');
  };
  $('#globals-list').onclick = () => openVarsModal('__globals__');

  // 标签
  $('#tabs').addEventListener('click', (e) => {
    const close = e.target.closest('[data-tabclose]');
    if (close) { e.stopPropagation(); closeTab(close.dataset.tabclose); return; }
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    state.activeTabId = tab.dataset.tab;
    renderTabs(); renderRequest(); saveSoon();
  });

  // 请求栏
  $('#method-select').innerHTML = METHODS.map(m => `<option value="${m}">${m}</option>`).join('');
  $('#method-select').onchange = (e) => { activeTab().request.method = e.target.value; touch(); renderTabs(); renderCounts(); };
  $('#url-input').oninput = (e) => {
    const tab = activeTab();
    tab.request.url = e.target.value;
    if (!tab.savedId) tab.name = nonEmpty(splitURL(e.target.value).base.split('/').filter(Boolean).pop(), '新请求');
    syncParamsFromURL(tab.request);  // URL 改动实时反映到 Params 表
    renderParamsKV();
    renderCounts();
    touch(); renderUrlHint();
  };
  // 页面始终显示原始 URL，不做编码规范化；编码只在发送时由后端处理
  $('#btn-send').onclick = sendRequest;
  $('#btn-save-request').onclick = saveRequestDialog;
  $('#btn-curl').onclick = async () => {
    const r = await api('/api/export/curl', { method: 'POST', body: JSON.stringify(activeTab().request) });
    if (r.ok && await copyText(r.command)) toast('cURL 已复制', 'success');
  };
  $('#btn-format-json').onclick = () => {
    const source = fold.active ? fold.original : $('#raw-body').value;
    try {
      const formatted = JSON.stringify(JSON.parse(source), null, 2);
      resetFold(formatted);
      activeTab().request.body.raw = formatted;
      touch(); toast('已格式化并保留换行', 'success');
    } catch (err) { toast('不是合法 JSON: ' + err.message, 'error'); }
  };
  $('#btn-minify-json').onclick = () => {
    const source = fold.active ? fold.original : $('#raw-body').value;
    try {
      const compact = JSON.stringify(JSON.parse(source));
      resetFold(compact);
      activeTab().request.body.raw = compact;
      touch(); toast('已压缩为单行', 'success');
    } catch (err) { toast('不是合法 JSON: ' + err.message, 'error'); }
  };
  $('#btn-wrap-toggle').onclick = () => { wrapOn = !wrapOn; applyWrap(); };
  $('#btn-fold-all').onclick = foldAllBlocks;
  $('#btn-expand-all').onclick = expandAllBlocks;
  $('#btn-fold-selection').onclick = () => toggleFoldAtLine(currentTextareaLine($('#raw-body')));
  $('#raw-body').ondblclick = () => {
    if (fold.active) toggleFoldAtLine(currentTextareaLine($('#raw-body')));
  };

  // 请求面板 tabs
  $$('#req-tabs .pane-tab').forEach(b => b.onclick = () => switchReqTab(b.dataset.reqtab));
  $$('#resp-tabs .pane-tab').forEach(b => b.onclick = () => switchRespTab(b.dataset.resptab));
  $('#pretty-lang').onchange = () => {
    const cached = state.responses[state.activeTabId];
    if (cached) renderResponse(cached.response, cached.tests);
  };

  // Body
  $('#body-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bodymode]');
    if (!b) return;
    const body = activeTab().request.body;
    body.mode = b.dataset.bodymode;
    renderBodyMode(); renderCounts(); touch();
  });
  $('#raw-lang').onchange = (e) => { activeTab().request.body.rawLang = e.target.value; touch(); };
  $('#raw-body').oninput = (e) => {
    if (fold.active) return; // 折叠是只读预览，真实值保存在 fold.original
    const r = activeTab().request;
    r.body.raw = e.target.value;
    fold.original = e.target.value;
    fold.blocks = computeJsonBlocks(fold.original);
    fold.map = fold.original.split('\n').map((_, i) => ({ origLine: i }));
    touch();
  };
  $('#graphql-query').oninput = (e) => { activeTab().request.body.graphqlQuery = e.target.value; touch(); };
  $('#graphql-vars').oninput = (e) => { activeTab().request.body.graphqlVariables = e.target.value; touch(); };
  $('#binary-base64').oninput = (e) => { activeTab().request.body.binaryData = e.target.value.trim(); touch(); };
  $('#binary-file').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const body = activeTab().request.body;
      body.binaryData = String(reader.result).split(',')[1] || '';
      body.binaryName = f.name;
      $('#binary-base64').value = body.binaryData;
      $('#binary-info').textContent = `已选择文件：${f.name} (${fmtBytes(f.size)})`;
      touch();
    };
    reader.readAsDataURL(f);
  };
  $('#auth-type').onchange = (e) => { activeTab().request.auth = { type: e.target.value }; renderAuthFields(); renderCounts(); touch(); };
  $('#pre-script').oninput = (e) => { activeTab().request.preScript = e.target.value; touch(); renderCounts(); };
  $('#test-script').oninput = (e) => { activeTab().request.testScript = e.target.value; touch(); renderCounts(); };
  $('#btn-bulk-params').onclick = () => openBulkEditor('批量编辑 Params', activeTab().request.params, rows => {
    activeTab().request.params = rows; renderRequest(); touch();
  });
  $('#btn-bulk-headers').onclick = () => openBulkEditor('批量编辑 Headers', activeTab().request.headers, rows => {
    activeTab().request.headers = rows; renderRequest(); touch();
  });

  // 响应操作
  $('#btn-find-response').onclick = openRespSearch;
  const respSearchInput = $('#resp-search-input');
  respSearchInput.addEventListener('input', (e) => scheduleRespSearch(e.target.value));
  respSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepRespSearch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeRespSearch(); }
  });
  $('#resp-search-next').onclick = () => { stepRespSearch(1); respSearchInput.focus(); };
  $('#resp-search-prev').onclick = () => { stepRespSearch(-1); respSearchInput.focus(); };
  $('#resp-search-close').onclick = closeRespSearch;
  $('#btn-copy-response').onclick = async () => {
    const cached = state.responses[state.activeTabId];
    if (!cached) return toast('还没有响应', 'error');
    if (await copyText(cached.response.bodyBase64 ? cached.response.body : cached.response.body)) toast('响应已复制', 'success');
  };
  $('#btn-download-response').onclick = () => {
    const cached = state.responses[state.activeTabId];
    if (!cached) return toast('还没有响应', 'error');
    const r = cached.response;
    if (r.bodyBase64) {
      const bytes = Uint8Array.from(atob(r.body), c => c.charCodeAt(0));
      download('response.bin', bytes, 'application/octet-stream');
    } else download('response.txt', r.body || '', 'text/plain');
  };

  // 拖动请求区/响应区分隔条：反向联动，当前可见的文本框也跟着缩放
  const handle = $('#split-handle');
  let dragging = false, startY = 0, startPaneH = 0, startTextH = 0, visibleArea = null;
  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startPaneH = $('.request-pane').getBoundingClientRect().height || 300;
    visibleArea = $$('.req-panel:not(.hidden) .code-area')[0] || null;
    startTextH = visibleArea ? (visibleArea.getBoundingClientRect().height || 130) : 0;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const paneNew = applyPaneHeight(startPaneH + e.clientY - startY);
    // raw Body 由 flex 自动跟随请求区高度，不能写 inline height 把 flex 挤掉
    if (visibleArea && visibleArea.id !== 'raw-body') {
      const h = Math.max(90, Math.min(700, startTextH + (paneNew - startPaneH)));
      visibleArea.style.height = h + 'px';
      persistEditorHeight(visibleArea.id, h);
    }
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    persistPane();
  });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === 'Enter') { e.preventDefault(); sendRequest(); }
    else if (e.key.toLowerCase() === 's') { e.preventDefault(); saveRequestDialog(); }
    else if (e.key.toLowerCase() === 't') { e.preventDefault(); newTab(); }
    else if (e.key.toLowerCase() === 'w') { e.preventDefault(); closeTab(state.activeTabId); }
    else if (e.key.toLowerCase() === 'f') { e.preventDefault(); openRespSearch(); }
  });

  // 页面关闭前尽力落盘（keepalive 让请求在页面卸载后仍能完成）
  window.addEventListener('pagehide', () => {
    if (!state.ws) return;
    state.ws.activeTabId = state.activeTabId;
    try {
      fetch('/api/workspace', {
        method: 'PUT', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.ws),
      });
    } catch (_) { /* 页面正在卸载，忽略 */ }
  });
}

function toggleCollapse(id) {
  if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
  localStorage.setItem('gopostman.collapsed', JSON.stringify([...state.collapsed]));
  renderCollections();
}

// ---------------------------------------------------------------- 测试钩子
// 仅暴露纯函数给离线回归测试（tests/ui-check.mjs）。不参与页面逻辑，无副作用。
window.__gopostmanTest = { syncURLFromParams, syncParamsFromURL, isEmptyValue, rawQueryPart };

// ---------------------------------------------------------------- 启动
(async function init() {
  try {
    await loadWorkspace();
    bindEvents();
    setupResizableEditors();
    applyWrap();
    renderAll();
    switchReqTab('params');
    switchRespTab('pretty');
    console.log('[GoPostman] 本地模式已就绪：无登录、无云同步');
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif">
      <h2>启动失败</h2><p>${esc(e.message)}</p>
      <p>请确认后端服务已启动，并通过 http://127.0.0.1:8080 访问。</p></div>`;
  }
})();
