# ADR-0002: 采用模块化编辑器内核与端口适配器

## Status

Accepted

## Context

iTwin Studio 当前大量路由、项目状态、场景运行时和 UI 集中在 `apps/web/src/App.tsx`，二维看板又依附于三维场景快照。继续直接增加二维编辑、桌面 Host、脚本和高级三维能力，会扩大修改影响面并形成循环依赖。

项目需要同时支持 B/S 与 Tauri C/S，但团队仍维护一套前端和一套服务器；当前规模不适合微服务化，也不适合一次性重写。目标是高内聚、低耦合、可渐进迁移，并尽量通过复用减少代码，而不是通过新增抽象增加代码。

## Decision

- 保持模块化单体和单仓库部署，不拆分业务微服务。
- 以 Studio Shell、Dashboard、Topology、Map/Geo、Scene、Data、Interaction、Publish 为 feature 边界；每个 feature 只从公开 `index.ts` 暴露类型和用例。
- Studio Core 只包含文档、命令、撤销、选择、引用和事件契约，不依赖 React、Three.js、Tauri、HTTP 或具体存储。
- Three.js、Browser、Tauri 和 Server 都作为指向 Core/Runtime ports 的 adapters。
- 跨 feature 协作使用稳定 ID、typed command/query 和少量领域事件；feature 内部优先直接、类型化调用，不使用全局万能 EventBus。
- 二维和三维复用命令、选择、属性 schema、快捷键、剪贴板、时间轴、变量、事件和资源引用，不强行统一各自的领域对象模型。
- 抽象只有在对应稳定外部边界或至少两个真实实现时建立；通用代码连续出现三次再提取，避免提前建设框架。
- 采用垂直切片迁移：建立新接口和回归夹具，迁移一条完整流程，切换默认路径，再删除旧实现。
- CI 增加架构测试：禁止跨 feature 深层导入、Core 反向依赖 adapter、循环依赖和未声明公共 API。

## Non-Functional Requirements

- 任何单一 feature 的失败不得破坏未依赖它的编辑流程。
- B/S 和 Tauri 对相同文档使用相同 Studio Core 与 Runtime。
- 不兼容旧项目、旧场景或旧发布链接；重构门禁使用功能能力清单与新 schema 黄金样本，代码版本仍可回滚。
- 常用编辑命令必须可撤销、可测试，并且不直接操作 React 组件实例。
- 构建、类型检查、架构测试和核心回归测试成为合并门禁。

## Consequences

### Positive

- Three.js、Tauri 或 UI 框架升级被 adapter 隔离。
- 二维和三维可以复用基础设施，同时保持各自简单的领域模型。
- 重构可以逐步交付，不需要长期维护第二套产品。
- 公共 API 和依赖方向使代码审查、测试和删除旧代码更容易。

### Negative

- 垂直切片期间允许少量内部脚手架，但不形成对外兼容 facade；新原生流程接通后必须立即删除。
- 公共 API 调整需要明确版本和迁移策略，不能随意跨模块取内部状态。
- 架构规则需要 CI 工具和持续维护。

### Neutral

- 模块边界不等同于 npm 包；只有出现真实构建或发布边界时才拆包。

## Failure Modes

| Failure | Impact | Mitigation |
| --- | --- | --- |
| 新旧实现长期双轨 | 代码量和行为差异持续增长 | 每个切片定义旧路径删除条件，验收后立即删除 |
| 通过全局 store 绕过边界 | feature 重新耦合 | 公开 selector/use case，CI 禁止深层导入 |
| 抽象层过多 | 阅读和调试成本上升 | 只为稳定边界或两个真实实现建 port；局部逻辑保持局部 |
| 领域事件泛滥 | 数据流难追踪 | 事件仅用于跨模块已发生事实，模块内使用直接 typed call |

## Alternatives Considered

**一次性重写**：拒绝。回归面和持续交付风险过大；不兼容旧数据并不意味着可以绕过现有功能能力回归。

**拆成微服务和多个前端**：拒绝。当前单服务器、单团队和本地客户端场景不值得承担网络协议、部署与运维复杂度。

**继续在 `App.tsx` 和场景 overlay 增量开发**：拒绝。无法形成独立二维编辑器，也无法安全承载脚本和场景扩展。

## References

- [iTwin Studio 产品与架构规划](../dev-studio-product-and-architecture-plan.md)
- [ADR-0001 轻量数字孪生集成边界](./0001-lightweight-digital-twin-integration.md)
