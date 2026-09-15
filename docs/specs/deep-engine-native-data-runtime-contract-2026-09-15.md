# Deep Native 数据运行时合同（D17–D19）

本合同冻结 Native 播放器的数据边界；实现可分批接入，但发布预检只能放行已实现的连接类型。

## 连接模型

`DataConnection` 仅包含 `id/type/endpointRef/schema/retryPolicy/cachePolicy`。凭据只能由目标机安全配置注入，禁止进入 SceneSnapshot、runtime package、日志或错误文本。`type` 首批为 `sim` 与 `http`; 未知类型默认 `blocked`。

## 状态机

连接状态统一为 `unconfigured → connecting → ready | stale | offline | failed | cancelled`。每次数据帧携带单调 `revision`、采集时间戳和错误码；乱序或过期帧不得覆盖较新状态。取消订阅必须使后续回调失效。

## sim 离线

`sim:` 使用包内版本化 fixture 与固定 seed，输出确定性数据帧；播放器启动不访问网络。场景切换销毁订阅，坏值按字段 schema 标记而非静默替换。sim 数据可同时驱动 Deep2D 与 3D，但不得伪装成实时外部连接。

## HTTP

请求必须有超时、取消令牌和有界指数退避；401/403、404、429、5xx、解析错误分别映射稳定错误码。断网时可按 `cachePolicy` 显示最后成功数据及更新时间，并明确 `stale/offline`。删除连接后不得继续发起请求。

## 可观测性与安全

日志只记录 connectionId、状态、错误码、耗时和重试次数；endpoint、Authorization、Cookie、响应正文和用户路径均须脱敏。诊断包执行凭据扫描，发现疑似 token 即阻断产物。

## 验收夹具

必须覆盖：无配置、权限拒绝、超时、断网重连、乱序响应、取消后迟到响应、空数据、坏值、缓存过期、连接删除以及 sim 固定 seed 重放。WebSocket/PostgreSQL 另行建适配器合同，未实现前预检为 `blocked`。
