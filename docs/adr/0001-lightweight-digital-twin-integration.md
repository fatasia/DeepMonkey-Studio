# ADR-0001: 轻量数字孪生集成边界

## Status

Accepted

## Context

BIM Studio 需要同时扩展实时渲染能力、工业数据接入和低代码看板。把 Node-RED 运行时、数据库驱动和流程编辑器直接打进 React/Three.js 前端会显著增加首屏体积、权限暴露和故障耦合；把每种协议直接写入查看器又会让场景代码无法维护。

目标是：普通场景编辑不依赖 Node-RED 也能工作；接入服务故障时只丢失实时数据，不影响模型浏览和场景保存；单个浏览器只订阅当前场景需要的数据。

## Decision

- 保持现有 Web + API 模块化单体，增加独立的 Node-RED 进程（默认端口 1880），由根目录脚本统一启停。
- Node-RED 负责 HTTP、WebSocket、MQTT、OPC UA、Modbus、BACnet 和数据库连接；浏览器仅消费统一的场景消息，不直接保存数据库凭据。
- 场景消息使用稳定的轻量信封：`source`、`key`、`value`、`timestamp`、可选 `target` 与 `action`。动作只允许更新显隐、颜色、位置和标签等显式白名单属性。
- Node-RED 编辑器与 Dashboard 独立加载，使用与 BIM Studio 一致的深色主题；主应用仅提供入口、连接状态和场景数据桥。
- Three.js 灯光、环境和材质状态进入场景快照，并保持旧快照缺省值兼容。
- WebXR 仅在 WebGL + HTTPS/localhost 环境启用；不支持时功能降级为普通查看器。

## Non-Functional Requirements

- Node-RED 不可用时，模型浏览、编辑和保存必须保持可用。
- 实时消息处理不得阻塞渲染循环；单帧只应用最近值，异常消息丢弃并记录连接状态。
- 外部连接凭据只保存在 Node-RED credential store，生产环境必须配置 `credentialSecret` 与访问认证。
- 默认单机部署面向公司内网，API/查看器 p95 交互不因未启用 IoT 而增加网络请求。
- 新功能保持场景 JSON 向后兼容，不提升现有 `schemaVersion`。

## Consequences

### Positive

- 协议和数据库节点可以独立升级，不污染查看器依赖。
- Node-RED 故障被隔离，普通 BIM 工作流无需运行它。
- 设备数据与三维对象之间通过显式映射关联，后续可审计和扩展。

### Negative

- 本地多一个服务和端口，需要单独保护 Node-RED 管理界面。
- Oracle、OPC UA 等可选节点依赖较大，首次安装时间增加。
- WebXR、WebGPU 和部分后处理能力不能共享完全相同的渲染路径。

### Neutral

- 数据库与设备驱动的连接参数由 Node-RED 管理，而不是 PostgreSQL 场景库管理。

## Failure Modes

| Failure | Impact | Mitigation |
| --- | --- | --- |
| Node-RED 停止 | 实时状态和看板离线 | 查看器保持可用并显示“数据桥离线”，脚本可单独重启 |
| WebSocket 消息风暴 | 帧率下降 | 按目标和属性合并，只在动画帧应用最后一条 |
| 环境贴图失效 | 反射/背景缺失 | 回退到天空预设或背景色 |
| XR 会话中断 | 返回普通画布 | 监听 session end 并恢复背景、相机控制和渲染循环 |
| 数据源凭据泄露 | 外部系统风险 | credential store、管理端认证、生产环境 TLS 与网络隔离 |

## Alternatives Considered

**把 Node-RED iframe 永久嵌入 Studio**：拒绝。编辑器体积、键盘/鼠标焦点和认证生命周期都会干扰三维工作区。

**前端直连 MySQL/Oracle/设备协议**：拒绝。浏览器协议能力不足，且会暴露凭据。

**拆成完整微服务体系**：暂不采用。当前团队和单机部署规模不值得承担服务发现、网关和可观测性成本。

## References

- https://nodered.org/docs/user-guide/runtime/configuration
- https://threejs.org/docs/#api/en/renderers/webxr/WebXRManager
