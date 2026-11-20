# Changelog

## v1.0.0 (2026-11-20)

首个版本：本地运行的 Postman 替代品，Go 单二进制 + 原生 Web，无账号、无登录、无云同步。

### 新增

- **请求构建**：GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS / TRACE / CONNECT；URL 与 Params 双向联动
- **Body**：`raw`（JSON / XML / HTML / JS / Text）、`form-data`（支持文件）、`x-www-form-urlencoded`、`GraphQL`、`binary`
- **认证**：Bearer、Basic、API Key（Header / Query），支持集合级继承与请求级覆盖
- **响应查看**：Pretty（JSON / XML 语法高亮）、Raw、Preview、Headers、Cookies、Test Results、实际请求
- **响应体查找**：`Ctrl+F` 打开，高亮命中并显示 `n/m`，回车 / Shift+回车跳转，Esc 关闭
- **集合**：集合 / 文件夹树、增删改、搜索、复制、多标签、请求历史
- **变量**：全局 / 集合 / 环境 / 脚本运行时四层作用域，`{{$timestamp}}`、`{{$guid}}`、`{{$randomInt}}`、`{{$isotimestamp}}` 等动态变量
- **脚本**：Pre-request Script 与 Tests，浏览器内执行轻量 `pm` API
- **导入导出**：Postman Collection v2.1、Postman 环境、cURL 双向转换、完整工作区备份
- **本地优先**：数据只写 `data/workspace.json`（原子写入、0600），默认仅监听 `127.0.0.1`，内置 `/api/echo` 可完全离线自测

### 编码规则

- 页面（URL、Params、导出结果）始终显示原始内容，不做预先编码
- 实际发送时统一按标准百分号编码：`>` → `%3E`、`:` → `%3A`、`,` → `%2C`、空格 → `%20`，幂等且不会二次编码
- 参数值里的 `=` 保持原样
- 只有 key 的裸参数（`TabID like .*`）不补 `=`；URL 里手写的空等号（`?a=`）则保留

### 已知限制

- 不做 OAuth2 交互式授权（直接填 token 到 Bearer 即可）
- 不支持 gRPC / WebSocket
- 不含 Mock / Monitor / Flows 等云端能力
- 忽略 TLS 证书错误默认开启，请求超时默认不限制，历史上限默认 1000 条，均可在设置中调整
