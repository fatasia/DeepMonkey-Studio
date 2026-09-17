# P1-13 切片：受控 HTTP/1.1 Transport（2026-09-18）

对应 [Deep2D 剩余任务](deep2d-remaining-tasks-2026-09-16.md) P1-13 的最后一格："HTTP Transport 真实绑定（受控 HTTP/订阅/异步握手/TLS）"。本片交付受控 HTTP；订阅式长连接与 TLS 保持后续切片，不冒充完成。

## 设计

`packages/deep-engine-native/src/chart/data_source/http_transport.rs`：

- **零新依赖**：`std::net::TcpStream`（内部 WinSock）实现，不引入 HTTP 客户端库；仓库"能复用就不重复实现+固定依赖"的约束下，HTTP/1.1 请求-响应语义的最小实现比拉入 reqwest/ureq 更符合受控离线交付。
- **`Transport` 合同不变**（connect/send/close 同步三件套）；HTTP 响应体缓存在实现内部，宿主在 `send` 返回 Up 后经固有方法 `take_response` 一次取净并泵入 `DataSourceMachine::on_receive`。状态机与既有 17 项测试零改动。
- **受控边界（fail-closed）**：仅明文 http；`Transfer-Encoding: chunked` 与无 `Content-Length` 拒绝；3xx 重定向拒绝（不跟随）；非 2xx 一律 `Unavailable` 带状态码；头区 64 KiB / 体 8 MiB 硬上限；读写超时映射 `Timeout`；`Connection: close` 单请求单响应，close 幂等。
- **凭据边界**：模块不持有凭据；认证由宿主在构造 config 前编入固定头部，不落盘不进日志（沿用 data_source 模块边界）。

## 测试（8 项，真实回环 socket，不用 mock IO）

`std::net::TcpListener` 一次性服务器矩阵：200 交付 + take_response 幂等取空；响应分包重组到 Content-Length；503 → `Unavailable` 带码；302 拒绝不跟随；chunked 与无长度双拒绝；静默服务器 → `Timeout`（80ms 短超时）；未连接先 send / close 幂等 / 重连轨迹；config 校验拒绝主机与路径注入字符（`\r\n` 头注入、空格、空 host）与越界超时。

门禁：lib 全量 318 通过 / 0 失败；clippy `-D warnings` 干净；fmt 干净。

## 明确未完成

- TLS、订阅式（服务器推送）、异步握手驻留未做——状态机注释已声明这三者是后续切片。
- `take_response` 的宿主泵循环装配（产品入口把响应体喂 `on_receive`）待接线切片。
