# ADR-0006: 将 Tauri 客户端与云渲染放在最终阶段

## Status

Accepted

## Context

产品最终需要 B/S、Tauri 本地客户端和可选云渲染。编辑器核心、二维/三维、脚本、转换、地图和拓扑仍在重构；过早开发桌面打包和 GPU 云渲染会扩大验证矩阵，并让核心接口被未稳定的交付形态牵制。

## Decision

- M0 至 M6 以服务器 Web 编辑、预览和发布为主，完成 Studio Core、Scene/Renderer Port、数据、脚本、转换、轻量 GIS、拓扑和插件生态。
- Tauri C/S 与云渲染都在 M7 最后实施，但前期保持文档可序列化、稳定对象 ID、统一输入事件、Host Adapter 和 Scene/Renderer Port。
- Tauri 打包同一套 Web UI/Runtime，增加服务器配置、安全令牌、本地工作区、恢复点、断点上传、转换 sidecar、签名和更新。
- 云渲染通过 `RemoteRenderSession` Adapter 接入 GPU Worker、WebRTC 和输入 DataChannel，不修改页面、脚本和 InteractionFlow 语义。
- 本地 WebGPU/WebGL、Tauri 和云渲染使用同一不可变发布包，并锁定 Scene Runtime 与插件版本。
- 云渲染是可选 Publication Profile；失败时不影响 Web/Tauri 编辑和其他已发布版本。

## Non-Functional Requirements

- Tauri 与浏览器对相同发布包产生一致业务行为。
- 云渲染会话彼此隔离，GPU Worker 失败只终止所属会话并回收资源。
- 固定内网基准中，云渲染输入到画面 p95 低于 150 ms，并记录编码、网络和渲染分段延迟。
- 云渲染鉴权绑定用户、项目、发布版本和会话；输入通道不能越权控制其他会话。
- 服务器地址变化但实例 ID 相同时，Tauri 可重新连接并保留本地草稿。

## Consequences

### Positive

- 核心产品价值先交付，桌面与 GPU 运维不会阻塞编辑器重构。
- 最终三种运行方式共享文档、运行时和插件，避免分叉。
- 云渲染保持可选，不增加普通部署的 GPU 成本。

### Negative

- Tauri 离线编辑和云渲染较晚可用。
- 前期必须严格遵守 ports 和序列化边界，否则 M7 会暴露返工。
- M7 同时涉及桌面、安全、GPU、媒体和运维，需单独人员与测试环境。

### Neutral

- 前期可以做小型技术验证，但不能把 Tauri 或云渲染加入主发布链路。

## Failure Modes

| Failure | Impact | Mitigation |
| --- | --- | --- |
| Core 偷用浏览器/Three 内部对象 | 无法远程或桌面复用 | 架构测试、稳定 ID、可序列化命令和 adapters |
| GPU Worker 崩溃 | 单个会话中断 | 心跳、会话隔离、回收与可选重连/本地回退 |
| 网络抖动 | 云画面延迟/模糊 | 自适应码率、延迟指标、输入背压和质量档位 |
| Tauri 地址或身份变化 | 无法同步/误发布 | serverInstanceId、重新登录、项目基线校验 |
| 插件不支持云环境 | 发布失败 | manifest 能力声明、预检和替代/本地运行 Profile |

## Alternatives Considered

**立即并行建设 Web、Tauri 和云渲染**：拒绝。会把当前重构的测试矩阵和运维复杂度放大三倍。

**永远不支持云渲染**：拒绝。未来超高画质、受控 GPU 环境和弱终端场景需要远程渲染出口。

**让云渲染维护独立项目格式和脚本**：拒绝。会导致编辑预览与线上行为分叉。

## References

- [Dev Studio 产品与架构规划](../dev-studio-product-and-architecture-plan.md)
- [ADR-0002 模块化编辑器内核](./0002-modular-editor-core.md)
- [ADR-0005 WebGPU 优先渲染](./0005-webgpu-first-rendering.md)
