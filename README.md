# GoPostman

一个用 Go 写的、**完全本地、不需要登录**的 Web 版 API 调试工具。打开浏览器就能发请求，集合、环境、历史全部存在本机一个 JSON 文件里。

---

## 为什么做这个

Postman 从 v10 开始逐步下线了离线工作区 Scratch Pad，改用需要账号的「轻量级 API 客户端」，保存请求到集合前会要求登录。这在社区里引起了很长的讨论：内网接口、敏感 Token、合规要求不允许数据出本机时，一个本地调试工具不该有账号体系。

所以这个复刻版从架构上就**没有登录这条路径**：

- 没有用户表、没有 session、没有 token 校验中间件；
- 所有 API 裸奔可用（默认只监听 `127.0.0.1`，外部访问不到）；
- 数据写入 `data/workspace.json`，不联网、不遥测、不云同步；
- 内置 `/api/echo` 回显端点，**断网也能完整演示**发请求 → 看响应 → 存集合 → 查历史。

调研来源（2026-11 检索）：

- [Postman 官方文档 · Postman elements](https://learning.postman.com/docs/getting-started/basics/postman-elements/) — 集合、环境、变量、工作区等核心概念
- [Postman 官方文档 · Send parameters and body data](https://learning.postman.com/docs/use/send-requests/create-requests/parameters/) — Body 的 form-data / urlencoded / raw / binary 等模式
- [Postman 官方文档 · Scratch Pad（已弃用）](https://learning.postman.com/docs/getting-started/basics/using-scratch-pad) — 离线模式被移除的说明
- [Postman Community · v10 no more offline mode](https://community.postman.com/t/postman-version-10-no-more-offline-mode-renders-postman-useless-for-many-developers/48812) — 强制登录引发的实际问题
- [Stack Overflow · Postman removed offline mode](https://stackoverflow.com/questions/77175558/postman-removed-offline-mode-scratch-pad-in-new-versions-is-there-a-way-to-en)

---

## 快速开始

需要 Go 1.21+（本项目在 Go 1.26 下构建，零第三方依赖）。

```bash
# 方式一：直接跑
go run .

# 方式二：编译成单文件可执行程序（前端已 embed 进二进制）
go build -o gopostman.exe .
./gopostman.exe

# Windows 也可以双击 start.bat
```

> 前端由 `//go:embed` 编译进二进制，因此修改 `web/` 下的文件后要重新执行一次 `go build`（或删掉 `gopostman.exe` 让 `start.bat` 自动重建）。

然后打开 <http://127.0.0.1:8080>。**没有注册、没有登录页、没有激活码。**

常用参数：

```bash
./gopostman.exe -addr 127.0.0.1:9090      # 换端口
./gopostman.exe -data D:/api/work.json    # 换数据文件位置
```

> 默认只绑定 `127.0.0.1`。如果确实需要局域网访问，显式指定 `-addr 0.0.0.0:8080`，并自行确认网络环境可信 —— 因为代理能访问你所在网络里的内网地址。

**默认设置**：忽略 TLS 证书错误 = **开启**（方便自签名证书 / 内网 HTTPS）；请求超时 = **不限制**（`0`，填正数毫秒才生效）；历史上限 = **1000 条**；跟随重定向 = 开启；最大响应体 = 8 MB；自动保存历史 = 开启。已有工作区会在首次启动时一次性迁移到这些默认值，之后你在设置面板里的修改会被保留，不会被再次覆盖。

---

## 功能对照

| Postman 能力 | GoPostman |
| --- | --- |
| 请求构建：Method / URL / Params / Headers | 支持 GET POST PUT PATCH DELETE HEAD OPTIONS TRACE CONNECT |
| URL ⇄ Params 双向联动 | 改 URL 的 query 实时刷新 Params 表；改表格回写 URL，禁用行不参与发送，自动去重 |
| 发送时编码、页面显示原始内容 | URL 栏与 Params 表始终显示用户输入；只在发请求时把 `>` → `%3E`、`:` → `%3A`、`,` → `%2C` 等，**值里的 `=` 保持原样**；先解码再编码保证幂等 |
| Body：`raw` / `form-data` / `x-www-form-urlencoded` / `GraphQL` / `binary` | 全部支持，form-data 可带文件，自动设置 Content-Type |
| JSON 编辑器 | 格式化 / 压缩 / 自动换行 / 按块折叠（只读预览，双击「… N 行」展开，原始数据不变） |
| 编辑器高度 | 整条底边可拖（不只是右下角）；请求区与响应区此消彼长，双向联动 |
| 认证：Bearer / Basic / API Key | 支持；OAuth2 交互式授权不做，直接把 token 填进 Bearer |
| 响应查看：Pretty / Raw / Preview / Headers / Cookies | 全部支持，含 JSON / XML 语法高亮、状态码、耗时、大小、重定向链 |
| 响应体查找 | 点「查找」或 `Ctrl+F`，在 Pretty / Raw 中高亮命中、显示 `n/m`、回车/Shift+回车跳转、Esc 关闭 |
| 集合与文件夹 | 树形组织、增删改、搜索、复制、保存请求 |
| 环境 / 全局 / 集合 / 运行时变量 | 四层作用域 + `{{$timestamp}}` `{{$guid}}` `{{$randomInt}}` `{{$isotimestamp}}` 等动态变量 |
| Pre-request Script / Tests | 浏览器内执行轻量 `pm` API（`pm.test` / `pm.expect` / `pm.response` / `pm.environment`） |
| 请求历史 / 多标签页 | 支持 |
| Cookie 自动管理 | 内存 Cookie Jar，后续请求自动携带，可一键清空 |
| 导入 / 导出 | Postman Collection v2.1、Postman 环境、全量导出包、cURL 命令、完整工作区备份 |
| **登录 / 云同步 / 团队工作区** | **整体移除（本项目的核心要求）** |
| Mock Server / Monitor / Flows / API 治理 / AI / gRPC / WebSocket / MQTT | 不做，超出「API Client 内核」范围 |

---

## 界面速览

```
┌──────────────────────────────────────────────────────────────┐
│ GoPostman  本地模式·免登录        环境[Local ▾]  导入 导出 设置    │
├───────────────┬──────────────────────────────────────────────┤
│ 集合/历史/环境 │ [GET 回显 ×] [+]          多标签                │
│               ├──────────────────────────────────────────────┤
│ ▾ 示例集合     │ [GET ▾] [ {{base_url}}/api/echo ] [发送] [保存]│
│   GET 回显     │ Params | Headers | Body | Auth | Scripts     │
│   POST JSON   ├──────────────────────────────────────────────┤
│   POST 表单   │ 响应 200 OK · 1 ms · 308 B                     │
│   带 Bearer   │ Pretty | Raw | Preview | Headers | Cookies    │
└───────────────┴──────────────────────────────────────────────┘
```

首次启动自带一个「示例集合 · 本机 Echo」，四个请求全部打到内置 `/api/echo`，直接点「发送」即可看到效果。

---

## 架构

```
浏览器 (原生 HTML/CSS/JS 单页)
   │  同源请求，无任何认证头
   ▼
Go net/http 服务（默认 127.0.0.1:8080，前端由 embed.FS 内嵌）
   ├── /api/send          ──► 目标 API（任意主机，绕过浏览器 CORS）
   ├── /api/workspace     ──► data/workspace.json（原子写入）
   ├── /api/import/*      ──► Postman v2.1 / cURL 解析
   ├── /api/echo          ──► 内置离线回显端点
   └── /api/cookies       ──► 内存 Cookie Jar
```

**为什么需要 Go 代发？** 浏览器受同源策略限制，无法直连任意 API，而且会过滤掉一批响应头。让本机服务代发，才能拿到真实的状态码、完整响应头、Set-Cookie 与耗时，同时支持任意 HTTP 方法。

**为什么不用数据库？** 单人本地工具，一个 JSON 文件足够；写入采用「临时文件 + 原子替换」，避免中途退出留下半截文件；文件权限 `0600`。

---

## 使用要点

**变量**：在 URL、Header、Body 里写 `{{name}}`。取值优先级为 `脚本运行时 > 当前环境 > 集合变量 > 全局变量`。示例环境里 `base_url` 留空，解析后得到相对路径 `/api/echo`，服务会自动补全为本机地址，方便离线调试。

**URL 与 Params**：两者是同一份数据的两种视图。在 URL 里写 `?where=ShotTime>20261112000000`，Params 表会立刻出现对应行；反过来改表格也会回写 URL。

**页面始终显示原始内容**：URL 栏、Params 表、导出的集合与 cURL 都不会把 `>` 预先改写成 `%3E`。编码只发生在 `/api/send` 真正发请求的那一刻——后端逐段「解码 → 替换变量 → 编码」，`>` → `%3E`、`:` → `%3A`、`,` → `%2C`、空格 → `%20`，其他符号同理。

两个细节：**参数值里的 `=` 不编码**（query 只按第一个 `=` 分割 key/value，值里的 `=` 是合法字符，如 `where=ShotTime>=2026` 发出的是 `where=ShotTime%3E=2026`）；编码是幂等的，已写成 `%3E` 的不会被二次编码成 `%253E`。`{{变量}}` 保留原文，替换成实际值后才编码，值里含 `&` `=` 也不会破坏参数结构。

**只有 key 的裸参数**（如 `TabID like .*`）：填在 Key 里、Value 留空即可，页面 URL 显示原文 `?TabID like .*`，**不会自动补末尾的 `=`**；实际发送时按规则编码成 `TabID%20like%20.*`。

**空等号的两种语义分开处理**：如果你确实需要 `key=`，直接在 URL 栏里手写那个等号，它会原样保留（内部用 `explicitEq` 标记，随工作区持久化）；而在 Params 表里只填 Key、没填 Value，默认就是不写等号。给这一行填上值后会正常带上 `=`，在 Params 里主动清空 Value 则退回"不写等号"。`?a=` 发 `a=`，`?a` 发 `a`，两者互不影响。

**JSON 编辑器**：`格式化 JSON` 在格式下拉框右侧；`压缩`、自动换行开关、折叠按钮在编辑区上方。折叠是只读预览，真实请求体始终完整，双击摘要行或点「展开全部」即可恢复，用法说明收在按钮的悬停提示里，不占用正文空间。

raw Body 文本框会**自动填满请求区剩余高度**，底边紧贴响应区，中间没有静态提示和留白；所有文本框底边都有一条可拖横条，拖它会同步缩放请求区、让下方响应区反向变化，拖两区之间的分隔条也一样。

**响应体查找**：点响应区右上角「查找」或按 `Ctrl+F`，输入关键字即可在 Pretty / Raw 里高亮命中，右上角显示 `当前/总数`，回车跳到下一个、`Shift+回车` 上一个、`Esc` 关闭。查找基于显示出来的文本，所以命中数不会因为语法高亮把内容拆成多个 `<span>` 而漏掉；支持 CSS Custom Highlight API 的浏览器会把语法着色完整保留（不改写 DOM），不支持的浏览器自动退化为纯文本高亮，功能一致。

**脚本**：

```js
// Pre-request Script
pm.environment.set('ts', Date.now().toString());

// Tests
pm.test('状态码是 200', () => pm.response.to.have.status(200));
pm.test('返回了数据', () => {
  pm.expect(pm.response.json().ok).to.eql(true);
});
```

脚本在浏览器里用 `new Function` 执行，导入的第三方集合如果含有脚本，可在「设置」里整体关闭执行。

**从 Postman 迁移**：Postman 里导出 Collection v2.1 / Environment JSON → 本工具「导入」→ 粘贴或选文件。反向也可导出为 Postman v2.1 格式。**全程不需要登录 Postman 账号**（导出功能本身不需要登录）。

---

## HTTP API

所有接口都不需要任何凭证；请求/响应体均为 JSON。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/meta` | 服务信息，含 `authRequired:false`、`cloudSync:false` |
| GET / PUT | `/api/workspace` | 读取 / 覆盖整个工作区 |
| POST | `/api/send` | 代理发送一次 HTTP 请求 |
| POST | `/api/import/postman` | 解析 Postman 集合 / 环境 / 全量导出包 |
| POST | `/api/import/environment` | 解析单个 Postman 环境 |
| POST | `/api/parse/curl` | cURL 命令 → 请求描述 |
| POST | `/api/export/curl` | 请求描述 → cURL 命令 |
| DELETE | `/api/cookies` | 清空 Cookie Jar |
| ANY | `/api/echo` | 内置回显端点 |

`/api/send` 请求示例：

```json
{
  "method": "POST",
  "url": "{{base_url}}/api/echo",
  "headers": [{ "key": "X-Token", "value": "{{token}}" }],
  "body": { "mode": "raw", "rawLang": "json", "raw": "{\"a\":1}" },
  "options": { "timeoutMs": 30000, "followRedirects": true },
  "variables": { "base_url": "", "token": "abc" }
}
```

---

## 测试

```bash
# 1) Go 单元测试：用 httptest 内存服务器，不需要启动常驻服务
go test ./... -v

# 2) 前端回归测试：jsdom + mock 接口，同样不需要启动服务
node tests/ui-check.mjs

# 3) 端到端冒烟测试：需要先启动服务
./gopostman.exe -data data/e2e.json
node tests/smoke.mjs http://127.0.0.1:8080
```

- `go test`：发送时标准编码与幂等性、值里的 `=` 保持原样、无等号裸参数（`TabID like .*`）、Params 去重、变量值含特殊字符不破坏结构、默认设置与一次性迁移、超时/TLS 开关。
- `tests/ui-check.mjs`：URL ⇄ Params 双向联动、**页面保持原始内容（失焦也不回写编码）**、Params 表显示含 `=` 的原始值、裸参数不补末尾 `=`、URL 显式空等号保留、Params 清空值后退回不写等号、`null/undefined` 值不产生多余 `=`、清空 query 不回填、响应体查找（计数 / 上下跳转 / 回车回绕 / 无命中 / Esc 恢复语法着色 / Highlight API 路径 / Ctrl+F）、JSON 格式化/折叠/展开/换行、按钮位置、默认设置、编辑区紧贴响应区、可拖手柄与双向高度联动，零运行时错误。已附带本地 `jsdom`（`data/testdeps`，被 gitignore 忽略）；若该目录被清理，执行 `npm install --no-save jsdom`。
- `tests/smoke.mjs`：57 个断言，覆盖免登录访问、9 种 HTTP 方法、5 种 Body 模式、4 种认证、变量替换与动态变量、发送时 query 编码与 `=` 保留、Postman 导入、cURL 互转、存储往返、Cookie 与静态资源回退。全部请求**刻意不携带任何认证头**。

---

## 目录

```
go-postman/
├── main.go         HTTP 路由、静态资源、内置回显端点
├── proxy.go        请求代理执行引擎、变量替换、Body 构造、Cookie Jar
├── importer.go     Postman v2.1 解析、cURL 解析与生成
├── store.go        本地 JSON 工作区持久化（原子写入）
├── types.go        前后端共用数据模型
├── web/            单页前端（embed 进二进制）
├── tests/smoke.mjs 端到端冒烟测试
└── data/           运行时生成的工作区文件（已 gitignore）
```

## 安全边界

- 默认只监听回环地址；把 `-addr` 改成 `0.0.0.0` 前请确认网络可信。
- `/api/send` 是通用 HTTP 代理，设计上就能访问本机与内网地址，这是本地调试工具的必要能力，不要把它暴露到公网。
- 「忽略 TLS 证书错误」默认**开启**，用于自签名证书 / 内网 HTTPS 调试；访问公网生产接口时建议在设置里关闭，恢复证书链校验。
- 请求超时默认**不限制**，调试长耗时接口不会被 30 秒掐断；需要防挂起时可在设置里填毫秒数。
- 响应体默认最多读取 8 MB，防止大响应撑爆内存，可在设置里调。
- 脚本在本地浏览器执行；导入陌生集合时可在设置中关闭脚本执行。
