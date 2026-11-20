// GoPostman 冒烟测试：所有请求刻意不携带任何凭证，用来证明「无强制登录」。
// 用法：先启动服务，再执行 `node tests/smoke.mjs [baseURL]`
const base = process.argv[2] || 'http://127.0.0.1:8080';

const request = async (path, body, method = 'POST') => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: res.status, data };
};

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const send = (payload) => request('/api/send', {
  options: { timeoutMs: 8000, followRedirects: true, maxBodyBytes: 1048576 },
  ...payload,
});
// 参数是 SendResponse 本体：data.body 就是 /api/echo 返回的 JSON 文本
const echoJSON = (resp) => {
  try { return typeof resp?.body === 'string' ? JSON.parse(resp.body) : null; }
  catch (_) { return null; }
};

console.log('\n=== 1. 免登录与基础端点 ===');
const meta = (await request('/api/meta', undefined, 'GET')).data;
check('meta.authRequired === false', meta.authRequired === false);
check('meta.cloudSync === false', meta.cloudSync === false);
check('meta.localOnly === true', meta.localOnly === true);

const ws = (await request('/api/workspace', undefined, 'GET')).data;
check('工作区含集合', Array.isArray(ws.collections) && ws.collections.length > 0);
check('工作区含环境', Array.isArray(ws.environments) && ws.environments.length > 0);
check('工作区含标签', Array.isArray(ws.tabs) && ws.tabs.length > 0);

console.log('\n=== 2. HTTP 代理：方法与变量 ===');
const getEcho = await send({
  method: 'GET', url: '{{base_url}}/api/echo',
  params: [{ key: 'hello', value: '{{who}}' }, { key: 'disabled', value: 'x', disabled: true }],
  headers: [{ key: 'X-Test', value: 'gopostman' }],
  variables: { base_url: '', who: 'world' },
});
const g = echoJSON(getEcho.data);
check('GET 相对 URL 自动补全 + 变量替换', getEcho.data.ok && getEcho.data.statusCode === 200, getEcho.data.error);
check('Params 生效', g?.query?.hello?.[0] === 'world');
check('禁用的 Param 被忽略', !g?.query?.disabled);
check('自定义 Header 生效', g?.headers?.['X-Test']?.[0] === 'gopostman');
check('返回耗时与大小', typeof getEcho.data.timeMs === 'number' && getEcho.data.size > 0);
check('返回 Set-Cookie', (getEcho.data.cookies || []).some(c => c.name === 'gopostman_demo'));

for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  const r = await send({ method: m, url: base + '/api/echo' });
  check(`${m} 方法可用`, r.data.ok && echoJSON(r.data)?.method === m);
}

console.log('\n=== 2b. URL query 标准百分号编码与 Params 去重 ===');
const literal = await send({ method: 'GET', url: base + '/api/echo?where=ShotTime>20261112000000&sort=a,b:desc' });
check('query 中的 > , : 转为 %3E %2C %3A', echoJSON(literal.data)?.rawQuery === 'where=ShotTime%3E20261112000000&sort=a%2Cb%3Adesc', echoJSON(literal.data)?.rawQuery);
const bare = await send({ method: 'GET', url: base + '/api/echo?ShotTime>20261112000000' });
check('无等号裸参数也编码', echoJSON(bare.data)?.rawQuery === 'ShotTime%3E20261112000000');
const dedup = await send({
  method: 'GET', url: base + '/api/echo?hello=world',
  params: [{ key: 'hello', value: 'world' }],
});
check('URL 与 Params 同键不重复', echoJSON(dedup.data)?.rawQuery === 'hello=world', echoJSON(dedup.data)?.rawQuery);
const appended = await send({
  method: 'GET', url: base + '/api/echo',
  params: [{ key: 'filter', value: 'ShotTime>20261112000000' }, { key: 'tag', value: 'a b&c' }],
});
check('追加参数按标准编码', echoJSON(appended.data)?.rawQuery === 'filter=ShotTime%3E20261112000000&tag=a%20b%26c', echoJSON(appended.data)?.rawQuery);
const already = await send({ method: 'GET', url: base + '/api/echo?where=ShotTime%3E2026' });
check('已编码的 %3E 不被二次编码', echoJSON(already.data)?.rawQuery === 'where=ShotTime%3E2026', echoJSON(already.data)?.rawQuery);
const equals = await send({ method: 'GET', url: base + '/api/echo?where=ShotTime>=2026&eq=a=b' });
check('参数值里的 = 保持原样、> 仍编码', echoJSON(equals.data)?.rawQuery === 'where=ShotTime%3E=2026&eq=a=b', echoJSON(equals.data)?.rawQuery);

console.log('\n=== 3. 请求体各模式 ===');
const raw = await send({
  method: 'POST', url: base + '/api/echo',
  body: { mode: 'raw', rawLang: 'json', raw: '{"v":"{{version}}"}' },
  variables: { version: 'v9' },
});
const rawEcho = echoJSON(raw.data);
check('raw JSON 变量替换', rawEcho?.body?.includes('v9'), rawEcho?.body);
check('raw JSON 自动 Content-Type', (rawEcho?.headers?.['Content-Type'] || []).join('').includes('application/json'));

const urlenc = await send({
  method: 'POST', url: base + '/api/echo',
  body: { mode: 'urlencoded', urlEncoded: [{ key: 'user', value: 'admin' }, { key: 'pwd', value: 'a b&c' }] },
});
const urlencEcho = echoJSON(urlenc.data);
check('urlencoded 编码正确', urlencEcho?.body === 'pwd=a+b%26c&user=admin', urlencEcho?.body);
check('urlencoded 自动 Content-Type', (urlencEcho?.headers?.['Content-Type'] || []).join('').includes('x-www-form-urlencoded'));

const form = await send({
  method: 'POST', url: base + '/api/echo',
  body: { mode: 'formdata', formData: [
    { key: 'field', value: 'text-value', type: 'text' },
    { key: 'upload', value: '', type: 'file', fileName: 'hello.txt', fileData: 'SGVsbG8gR28=' },
  ] },
});
const formEcho = echoJSON(form.data);
check('form-data multipart 生效', (formEcho?.headers?.['Content-Type'] || []).join('').includes('multipart/form-data'));
check('form-data 文本字段', String(formEcho?.body || '').includes('text-value'));
check('form-data 文件字段', String(formEcho?.body || '').includes('hello.txt') && String(formEcho?.body || '').includes('Hello Go'));

const gql = await send({
  method: 'POST', url: base + '/api/echo',
  body: { mode: 'graphql', graphqlQuery: 'query { ping }', graphqlVariables: '{"id":1}' },
});
const gqlEcho = echoJSON(gql.data);
check('GraphQL 封装为 JSON', gqlEcho?.body?.includes('query { ping }') && gqlEcho?.body?.includes('"id":1'), gqlEcho?.body);

const bin = await send({
  method: 'POST', url: base + '/api/echo',
  body: { mode: 'binary', binaryName: 'a.bin', binaryData: 'SGVsbG8=' },
});
check('binary base64 解码发送', echoJSON(bin.data)?.body === 'Hello', String(echoJSON(bin.data)?.body));

console.log('\n=== 4. 认证 ===');
const bearer = await send({
  method: 'GET', url: base + '/api/echo', auth: { type: 'bearer', bearer: '{{token}}' },
  variables: { token: 'abc123' },
});
check('Bearer Token', echoJSON(bearer.data)?.headers?.Authorization?.[0] === 'Bearer abc123');

const basic = await send({
  method: 'GET', url: base + '/api/echo', auth: { type: 'basic', username: 'u', password: 'p' },
});
check('Basic Auth', String(echoJSON(basic.data)?.headers?.Authorization?.[0] || '').startsWith('Basic '));

const apikey = await send({
  method: 'GET', url: base + '/api/echo',
  auth: { type: 'apikey', apiKeyKey: 'X-Key', apiKeyValue: 'k1', apiKeyIn: 'query' },
});
check('API Key in Query', echoJSON(apikey.data)?.query?.['X-Key']?.[0] === 'k1');

const apikeyH = await send({
  method: 'GET', url: base + '/api/echo',
  auth: { type: 'apikey', apiKeyKey: 'X-Key', apiKeyValue: 'k2', apiKeyIn: 'header' },
});
check('API Key in Header', echoJSON(apikeyH.data)?.headers?.['X-Key']?.[0] === 'k2');

console.log('\n=== 5. 动态变量与错误处理 ===');
const dyn = await send({
  method: 'GET', url: base + '/api/echo',
  params: [{ key: 'ts', value: '{{$timestamp}}' }, { key: 'guid', value: '{{$guid}}' }],
  variables: {},
});
const dynEcho = echoJSON(dyn.data);
check('{{$timestamp}} 动态变量', /^\d{10}$/.test(dynEcho?.query?.ts?.[0] || ''));
check('{{$guid}} 动态变量', /^[0-9a-f-]{36}$/.test(dynEcho?.query?.guid?.[0] || ''));

const badURL = await send({ method: 'GET', url: 'ftp://example.com/x' });
check('非法协议被拒绝', badURL.data.ok === false && badURL.data.error.includes('http'), badURL.data.error);
const emptyURL = await send({ method: 'GET', url: '' });
check('空 URL 被拒绝', emptyURL.data.ok === false);

console.log('\n=== 6. 导入 / 导出 / cURL ===');
const curlCmd = "curl -X POST 'https://api.example.com/items' -H 'Content-Type: application/json' -d '{\"name\":\"test\"}'";
const curl = await request('/api/parse/curl', { command: curlCmd });
check('cURL 解析 method', curl.data.ok && curl.data.request.method === 'POST');
check('cURL 解析 headers', (curl.data.request.headers || []).some(h => h.key === 'Content-Type'));
check('cURL 解析 raw body', curl.data.request.body?.mode === 'raw' && curl.data.request.body.raw.includes('test'));

const curlOut = await request('/api/export/curl', {
  method: 'POST', url: 'https://api.example.com/a',
  params: [{ key: 'q', value: '1' }], headers: [{ key: 'Accept', value: 'application/json' }],
  body: { mode: 'raw', rawLang: 'json', raw: '{"a":1}' }, auth: { type: 'bearer', bearer: 'tk' },
});
check('导出 cURL 含 method / header / body / auth',
  curlOut.data.ok && curlOut.data.command.includes('-X \'POST\'') && curlOut.data.command.includes('q=1')
  && curlOut.data.command.includes('Authorization: Bearer tk') && curlOut.data.command.includes('--data-raw'));

const pmCollection = {
  info: { name: 'Imported API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: 'TOKEN', type: 'string' }] },
  item: [
    { name: 'Users', item: [
      { name: 'List users', request: { method: 'GET', header: [{ key: 'Accept', value: 'application/json' }],
        url: { raw: 'https://api.example.com/users?page=1', protocol: 'https', host: ['api', 'example', 'com'] },
        auth: { type: 'noauth' } } },
    ] },
    { name: 'Create user', request: { method: 'POST',
      header: [{ key: 'Content-Type', value: 'application/json' }],
      url: { raw: 'https://api.example.com/users' },
      body: { mode: 'raw', raw: '{"name":"Bob"}', options: { raw: { language: 'json' } } },
      event: [{ listen: 'test', script: { type: 'text/javascript', exec: ['pm.test("ok", function(){ pm.response.to.have.status(200); });'] } }] } },
  ],
  variable: [{ key: 'base', value: 'https://api.example.com', type: 'string' }],
};
const imp = await request('/api/import/postman', { content: JSON.stringify(pmCollection) });
check('导入 Postman 集合', imp.data.ok && imp.data.collections.length === 1);
const col = imp.data.collections?.[0];
check('集合名与变量', col?.name === 'Imported API' && col?.variables?.[0]?.key === 'base');
check('文件夹递归', col?.items?.[0]?.type === 'folder' && col?.items?.[0]?.items?.length === 1);
check('URL / Params 还原', col?.items?.[0]?.items?.[0]?.request?.url?.includes('page=1'));
check('raw body + 语言', col?.items?.[1]?.request?.body?.rawLang === 'json');
check('Tests 脚本还原', (col?.items?.[1]?.request?.testScript || '').includes('pm.test'));
check('集合级 Bearer 与请求级 NoAuth', col?.items?.[0]?.items?.[0]?.request?.auth?.type === 'none' && col?.auth?.type === 'bearer');

const pmEnv = { name: 'Staging', values: [{ key: 'host', value: 'https://staging.example.com', enabled: true, type: 'default' }] };
const envImp = await request('/api/import/environment', { content: JSON.stringify(pmEnv) });
check('导入 Postman 环境', envImp.data.ok && envImp.data.environment?.values?.[0]?.value?.includes('staging'));

const dump = { collections: [pmCollection], environments: [pmEnv] };
const bundle = await request('/api/import/postman', { content: JSON.stringify(dump) });
check('导入 Postman 全量导出包', bundle.data.ok && bundle.data.collections.length === 1 && bundle.data.environments.length === 1);

console.log('\n=== 7. 存储往返 / Cookie / 静态回退 ===');
const originalName = ws.collections[0].name;
const modified = { ...ws, collections: [{ ...ws.collections[0], name: '__smoke_test__' }] };
const put = await request('/api/workspace', modified, 'PUT');
check('PUT 工作区', put.status === 200 && put.data.ok === true);
const ws2 = (await request('/api/workspace', undefined, 'GET')).data;
check('GET 读回修改', ws2.collections[0].name === '__smoke_test__');
await request('/api/workspace', ws, 'PUT');
const ws3 = (await request('/api/workspace', undefined, 'GET')).data;
check('恢复原始数据', ws3.collections[0].name === originalName);

const cookies = await request('/api/cookies', undefined, 'DELETE');
check('清空 Cookie 罐无需凭证', cookies.data.ok === true);

const fallback = await fetch(base + '/some/spa/route');
const html = await fallback.text();
check('未知路径回退 index.html', fallback.status === 200 && html.includes('GoPostman'));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail ? 1 : 0);
