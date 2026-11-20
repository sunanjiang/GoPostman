// 前端回归测试：jsdom + mock 接口，不依赖运行中的服务。
// 验证 URL⇄Params 联动、特殊字符、JSON 格式化/折叠/换行、可拖手柄与双向高度联动。
// 用法：npm install --no-save jsdom && node tests/ui-check.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadJSDOM() {
  for (const candidate of ['jsdom', '../data/testdeps/node_modules/jsdom']) {
    try { return require(candidate); } catch (_) { /* try next */ }
  }
  console.error('缺少 jsdom：在项目根目录执行 npm install --no-save jsdom 后重试');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = loadJSDOM();

const base = 'http://127.0.0.1:8080';
const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'web/style.css'), 'utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + e.message));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const ws = {
  version: 1,
  collections: [{ id: 'c1', name: '示例集合', items: [], variables: [] }],
  environments: [{ id: 'e1', name: 'Local', values: [{ key: 'base_url', value: '' }] }],
  activeEnvId: 'e1', globals: [], history: [],
  tabs: [{ id: 't1', name: 'GET 回显', request: {
    method: 'GET', url: '{{base_url}}/api/echo',
    params: [{ key: 'hello', value: 'world' }], headers: [],
    body: { mode: 'none' }, auth: { type: 'inherit' },
  } }],
  activeTabId: 't1',
  settings: { timeoutMs: 0, followRedirects: true, insecureSkipVerify: true, maxBodyBytes: 8388608, saveHistory: true, historyLimit: 1000, settingsVersion: 2 },
};

const dom = new JSDOM(html, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
const doc = window.document;
window.console = { log() {}, warn() {}, error: (...a) => errors.push('console.error: ' + a.join(' ')), info() {} };
let lastSend = null;
window.fetch = async (p, o = {}) => {
  const url = new URL(p, base).toString();
  const method = o.method || 'GET';
  let data = {};
  if (url.endsWith('/api/meta')) data = { authRequired: false, cloudSync: false, cookieCount: 0, dataFile: 'x' };
  else if (url.endsWith('/api/workspace') && method === 'GET') data = JSON.parse(JSON.stringify(ws));
  else if (url.endsWith('/api/workspace')) data = { ok: true };
  else if (url.endsWith('/api/send')) {
    lastSend = JSON.parse(o.body);
    data = {
      ok: true, statusCode: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId: 'alpha', nested: { tabId: 'beta' }, list: [1, 2, 3] }),
      timeMs: 1, size: 64, cookies: [],
    };
  } else if (url.endsWith('/api/export/curl')) data = { ok: true, command: 'curl' };
  else data = { ok: true };
  return { status: 200, ok: true, json: async () => data, text: async () => JSON.stringify(data) };
};
window.addEventListener('error', e => errors.push('window.error: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', e => errors.push('unhandledrejection: ' + e.reason));

const wait = ms => new Promise(r => setTimeout(r, ms));
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const url = () => doc.querySelector('#url-input').value;
const paramRows = () => doc.querySelectorAll('#params-kv .kv-row').length;
const paramValue = i => doc.querySelectorAll('#params-kv [data-field="value"]')[i]?.value;

try { window.eval(js); } catch (e) { errors.push('eval: ' + e.stack); }
await wait(900);

console.log('\n=== URL ⇄ Params 联动 ===');
check('旧 Params 自动补进 URL', url().includes('?hello=world'), url());
check('Params 表由 URL 解析出 1 行', paramRows() === 1, String(paramRows()));

const urlInput = doc.querySelector('#url-input');
urlInput.value = 'http://api.test/search?where=ShotTime>20261112000000&sort=a,b:desc';
fire(urlInput, 'input');
await wait(100);
check('改 URL 后 Params 表出现 2 行', paramRows() === 2, String(paramRows()));
check('Params 值保留 > 字面量', paramValue(0) === 'ShotTime>20261112000000', String(paramValue(0)));
check('Params 表显示解码后的可读值 : ,', paramValue(1) === 'a,b:desc', String(paramValue(1)));

urlInput.dispatchEvent(new window.Event('blur'));
await wait(60);
check('页面 URL 保持原始内容（失焦也不回写 %3E / %3A / %2C）',
  url().includes('where=ShotTime>20261112000000') && url().includes('sort=a,b:desc') &&
  !url().includes('%3E') && !url().includes('%2C'), url());

const firstValue = doc.querySelectorAll('#params-kv [data-field="value"]')[0];
firstValue.value = 'ShotTime>=20261113000000';
fire(firstValue, 'input');
await wait(100);
check('改 Params 值原样回写 URL', url().includes('where=ShotTime>=20261113000000'), url());
check('页面回写时 > = 保持原样，不转 %3E / %3D',
  !url().includes('%3E') && !url().includes('%3D'), url());
check('Params 表显示原始值（含 =）', paramValue(0) === 'ShotTime>=20261113000000', String(paramValue(0)));

const addBtn = doc.querySelector('#params-kv .kv-add');
addBtn.click();
await wait(50);
const keyInputs = doc.querySelectorAll('#params-kv [data-field="key"]');
const lastKey = keyInputs[keyInputs.length - 1];
lastKey.value = 'page'; fire(lastKey, 'input');
const valInputs = doc.querySelectorAll('#params-kv [data-field="value"]');
const lastVal = valInputs[valInputs.length - 1];
lastVal.value = '2'; fire(lastVal, 'input');
await wait(100);
check('新增 Params 行同步到 URL', url().includes('&page=2'), url());

const checks = doc.querySelectorAll('#params-kv [data-field="disabled"]');
checks[1].checked = false; fire(checks[1], 'change');
await wait(100);
check('禁用参数后 URL 移除该参数', !url().includes('sort='), url());

urlInput.value = 'http://api.test/search';
fire(urlInput, 'input');
await wait(80);
const remaining = [...doc.querySelectorAll('#params-kv .kv-row')];
const onlyDisabledLeft = remaining.every(row => row.classList.contains('disabled'));
check('手动删掉 query 后 URL 不回填启用参数', !url().includes('?') && onlyDisabledLeft, `${remaining.length} 行 / ${url()}`);

console.log('\n=== 裸参数表达式（TabID like .*）===');
// 重绘后旧节点会失效，必须重新查询
doc.querySelector('#params-kv .kv-add').click();
await wait(50);
const bareKeys = doc.querySelectorAll('#params-kv [data-field="key"]');
const bareKey = bareKeys[bareKeys.length - 1];
bareKey.value = 'TabID like .*';
fire(bareKey, 'input');
await wait(100);
check('裸参数在 URL 里保持原文（空格 / .* 不编码）', url().endsWith('?TabID like .*'), url());
check('裸参数末尾不多出 "="', !url().endsWith('='), url());

const bareVals = doc.querySelectorAll('#params-kv [data-field="value"]');
const bareVal = bareVals[bareVals.length - 1];
bareVal.value = 'x';
fire(bareVal, 'input');
await wait(80);
check('给裸参数填值后重新带上 "="', url().endsWith('TabID like .*=x'), url());
bareVal.value = '';
fire(bareVal, 'input');
await wait(80);
check('清空值后又变回裸参数', url().endsWith('?TabID like .*') && !url().endsWith('='), url());

// null / undefined 值是历史上末尾多 "=" 的根因，必须按空值处理
window.__gopostmanTest.syncURLFromParams({ url: 'http://h/x', params: [{ key: 'TabID like .*', value: null }, { key: 'b', value: undefined }] });
check('null / undefined 值不产生多余 "="', url() === 'http://h/x?TabID like .*&b', url());

// URL 里手写的等号和 Params 表里没填值，语义必须分开
const explicit = { url: 'http://h/x?TabID like .*=&b', params: [] };
window.__gopostmanTest.syncParamsFromURL(explicit, true);
window.__gopostmanTest.syncURLFromParams(explicit);
check('URL 里显式写的空等号被保留', explicit.url === 'http://h/x?TabID like .*=&b', explicit.url);
check('显式等号行标记 explicitEq', explicit.params[0]?.explicitEq === true, JSON.stringify(explicit.params));
check('无等号的裸参数行标记 noEq', explicit.params[1]?.noEq === true, JSON.stringify(explicit.params));

// 在 Params 表里主动清空 value，应退回"默认不保留等号"
urlInput.value = 'http://h/x?TabID like .*=';
fire(urlInput, 'input');
await wait(80);
const eqVal = doc.querySelector('#params-kv [data-field="value"]');
eqVal.value = 'x'; fire(eqVal, 'input');
await wait(40);
eqVal.value = ''; fire(eqVal, 'input');
await wait(80);
check('在 Params 里清空值后不再保留等号', url().endsWith('?TabID like .*') && !url().endsWith('='), url());

// 页面只负责显示原文，编码留给 /api/send
urlInput.value = 'http://h/x?TabID like .*';
fire(urlInput, 'input');
await wait(100);
doc.querySelector('#btn-send').click();
await wait(250);
check('发送时 URL 仍是原文（编码交给后端）', lastSend?.url === 'http://h/x?TabID like .*', lastSend?.url);
const sentBare = (lastSend?.params || []).find(p => p.key === 'TabID like .*');
check('发送时裸参数不带 "="，标记 noEq', sentBare?.noEq === true && sentBare?.value === '', JSON.stringify(lastSend?.params));

console.log('\n=== JSON 格式化 / 折叠 / 换行 ===');
doc.querySelector('[data-reqtab="body"]').click();
check('格式化按钮位于 JSON 选项右侧', doc.querySelector('#raw-lang')?.nextElementSibling?.id === 'btn-format-json');
check('非 raw 模式隐藏格式化按钮', doc.querySelector('#btn-format-json').classList.contains('hidden'));
doc.querySelector('[data-bodymode="raw"]').click();
check('raw 模式显示格式化按钮', !doc.querySelector('#btn-format-json').classList.contains('hidden'));
const raw = doc.querySelector('#raw-body');
raw.value = '{"user":{"id":1,"name":"Ann"},"tags":["a","b"],"ok":true}';
fire(raw, 'input');
doc.querySelector('#btn-format-json').click();
await wait(50);
check('格式化后产生多行换行', raw.value.split('\n').length >= 8, String(raw.value.split('\n').length));
check('格式化后含缩进', raw.value.includes('\n  "user"'), raw.value.slice(0, 60));

doc.querySelector('#btn-fold-all').click();
await wait(50);
check('折叠进入只读预览', raw.readOnly === true);
check('折叠显示摘要行', raw.value.includes('…'), raw.value.slice(0, 100));
check('折叠后显示 2 个顶层摘要行', (raw.value.match(/…/g) || []).length === 2, raw.value);
check('折叠后行数减少', raw.value.split('\n').length < 8, String(raw.value.split('\n').length));
const foldedDisplay = raw.value;
check('折叠未破坏原始值（状态保留）', foldedDisplay.length < 100);
doc.querySelector('#btn-expand-all').click();
await wait(50);
check('展开恢复完整原始 JSON', !raw.readOnly && raw.value.includes('"name": "Ann"'), raw.value.slice(0, 80));
check('展开后仍保留换行', raw.value.split('\n').length >= 8);

const wrapBtn = doc.querySelector('#btn-wrap-toggle');
check('默认开启自动换行', raw.classList.contains('wrap'));
wrapBtn.click();
check('可关闭自动换行', !raw.classList.contains('wrap'));
wrapBtn.click();
check('可重新开启自动换行', raw.classList.contains('wrap'));

console.log('\n=== 编辑区紧贴响应区 / 高度手柄 ===');
check('body 与响应之间的静态提示已移除', !doc.querySelector('.editor-tip'));
check('raw Body 面板启用 flex 填充', doc.querySelector('[data-reqpanel="body"]').classList.contains('raw-active'));
check('raw Body 不设固定 inline 高度', !raw.style.height, raw.style.height);
const areas = [...doc.querySelectorAll('.code-area')];
const withHandle = areas.filter(a => a.nextElementSibling?.classList.contains('editor-resize'));
check('每个常驻文本框都有整边拖动手柄', withHandle.length === areas.length, `${withHandle.length}/${areas.length}`);
check('原生 resize 已禁用（CSS）', /\.code-area\s*\{[^}]*resize:\s*none/.test(css));
const handle = doc.querySelector('#raw-body + .editor-resize');
const paneBefore = doc.querySelector('.request-pane').style.flex;
handle.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientY: 100 }));
doc.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientY: 260 }));
doc.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
check('拖文本框同步改变请求区高度（响应区对应缩小）',
  doc.querySelector('.request-pane').style.flex !== paneBefore && doc.querySelector('.request-pane').style.flex.includes('%'),
  `${paneBefore} -> ${doc.querySelector('.request-pane').style.flex}`);

const paneBefore2 = doc.querySelector('.request-pane').style.flex;
const split = doc.querySelector('#split-handle');
split.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientY: 300 }));
doc.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientY: 240 }));
doc.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
check('拖分隔条反向改变请求区高度（响应区对应放大）',
  doc.querySelector('.request-pane').style.flex !== paneBefore2,
  `${paneBefore2} -> ${doc.querySelector('.request-pane').style.flex}`);
check('反向联动后 raw Body 仍保持 flex 填充', !raw.style.height, raw.style.height);

console.log('\n=== 响应体查找 ===');
const findBtn = doc.querySelector('#btn-find-response');
const countText = () => doc.querySelector('#resp-search-count').textContent;
const hitMarks = () => [...doc.querySelectorAll('#pretty-view mark.resp-hit')];
const searchInput = doc.querySelector('#resp-search-input');

findBtn.click();
await wait(60);
check('查找条打开并聚焦输入框', !doc.querySelector('#resp-search').classList.contains('hidden') && doc.activeElement === searchInput);

searchInput.value = 'tabId';
fire(searchInput, 'input');
await wait(240);
check('命中计数显示 1/2', countText() === '1/2', countText());
check('Pretty 中两处命中都被高亮', hitMarks().length === 2, String(hitMarks().length));
check('第一个命中标记为 current', hitMarks()[0]?.classList.contains('current') === true);

doc.querySelector('#resp-search-next').click();
await wait(80);
check('点下一个跳到 2/2', countText() === '2/2', countText());
check('第二个命中成为 current', hitMarks()[1]?.classList.contains('current') === true);

searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await wait(60);
check('回车回绕到第一个', countText() === '1/2', countText());
searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
await wait(60);
check('Shift+回车回到上一个', countText() === '2/2', countText());

searchInput.value = 'zzz-not-found';
fire(searchInput, 'input');
await wait(240);
check('无命中显示 0/0 并标红', countText() === '0/0' && doc.querySelector('#resp-search-count').classList.contains('no-hit'), countText());

searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(80);
check('Esc 关闭查找条', doc.querySelector('#resp-search').classList.contains('hidden'));
check('关闭后清除高亮并恢复语法着色',
  doc.querySelectorAll('#pretty-view mark').length === 0 && doc.querySelectorAll('#pretty-view .tok-key').length > 0);

// 切到 Raw 也能查找
doc.querySelector('[data-resptab="raw"]').click();
findBtn.click();
await wait(60);
searchInput.value = 'tabId';
fire(searchInput, 'input');
await wait(240);
check('Raw 视图同样能高亮命中', doc.querySelectorAll('#raw-view mark.resp-hit').length === 2,
  String(doc.querySelectorAll('#raw-view mark.resp-hit').length));
searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(60);

// 模拟支持 CSS Custom Highlight API 的浏览器：应不改 DOM、语法高亮保持
window.Highlight = class { constructor(...ranges) { this.ranges = ranges; } };
window.CSS = window.CSS || {};
window.CSS.highlights = new Map();
doc.querySelector('[data-resptab="pretty"]').click();
await wait(60);
findBtn.click();
await wait(60);
searchInput.value = 'tabId';
fire(searchInput, 'input');
await wait(240);
const hl = window.CSS.highlights.get('resp-hit');
check('Highlight API 路径命中 2 处', hl?.ranges?.length === 2, String(hl?.ranges?.length));
check('Highlight API 路径不改写 DOM（无 mark）', doc.querySelectorAll('#pretty-view mark').length === 0);
check('Highlight API 路径保留语法着色', doc.querySelectorAll('#pretty-view .tok-key').length > 0);
doc.querySelector('#resp-search-close').click();
await wait(60);

// Ctrl+F 打开
doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
await wait(60);
check('Ctrl+F 打开查找条', !doc.querySelector('#resp-search').classList.contains('hidden'));
doc.querySelector('#resp-search-close').click();
await wait(60);

console.log('\n=== 设置默认值 ===');
doc.querySelector('#modal-root').innerHTML = '';
doc.querySelector('#btn-settings').click();
check('默认忽略 TLS 证书错误', doc.querySelector('#set-insecure').checked === true);
check('默认请求超时不限制 (0)', doc.querySelector('#set-timeout').value === '0', doc.querySelector('#set-timeout').value);
check('默认历史上限 1000 条', doc.querySelector('#set-historylimit').value === '1000', doc.querySelector('#set-historylimit').value);
doc.querySelector('#set-save').click();
await wait(150);
doc.querySelector('#btn-settings').click();
check('保存后超时仍保持不限制（不被回退成 30000）', doc.querySelector('#set-timeout').value === '0', doc.querySelector('#set-timeout').value);
doc.querySelector('.modal-close').click();

console.log('\n=== 运行时错误 ===');
check('无 JS 运行时错误', errors.length === 0, errors.slice(0, 4).join(' | '));
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
dom.window.close();
process.exit(fail ? 1 : 0);
