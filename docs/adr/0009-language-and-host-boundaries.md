# ADR-0009: 以 TypeScript 为主并按宿主隔离 C#/Rust/Python

## Status

Accepted

## Context

Dev Studio 同时包含 Web 编辑器、Node.js 服务器、Tauri 客户端、Revit 接入、插件、模型转换和可选仿真。若为每类能力随意引入语言和常驻服务，跨语言 Schema、错误协议、构建、部署、调试和升级成本会快速增加。项目要求高内聚、低耦合、代码可读并尽量减少代码量。

当前主应用已经使用 TypeScript/React/Vite、Three.js 和 Node.js/Fastify；Revit Worker/Add-in 已使用 C#/.NET；另有两个 Python Revit 导出脚本作为旧式/辅助路径。M7 采用 Tauri 2，原生宿主天然需要少量 Rust。M8 旧原型包含 Rust 离散事件实现，但轻量仿真不应因此强制所有部署安装另一套业务后端。

## Decision

采用“TypeScript 主干 + 宿主适配语言”的语言边界：

| 范围 | 默认语言 | 边界 |
| --- | --- | --- |
| Web UI、2D/3D 编辑器、SDK、插件 | TypeScript | React/Three 只存在于对应 adapter/feature |
| 主服务器 API、WebSocket、Data Hub | TypeScript on Node.js/Fastify | I/O 与协议主干；CPU 任务交给 Worker/任务适配器 |
| 浏览器/Tauri 项目脚本 | TypeScript/JavaScript | 公式 AST、Worker 沙箱或签名可信扩展 |
| Revit Add-in 与 Worker | C#/.NET | 只通过版本化任务/产物协议与服务器交互 |
| Tauri 原生宿主 | Rust | 保持薄层：文件、凭据、sidecar、更新、窗口和系统集成 |
| 工厂物流仿真 | TypeScript Worker | 通过 `SimulationEnginePort` 可选替换为 Rust/WASM 加速器 |
| AI 训练、数据科学、特殊离线工具 | Python（可选） | 独立任务/插件，不成为主服务或客户端运行前提 |

- 不把主后端改写为 Python。前后端、应用文档、SDK、REST/WebSocket 和插件 manifest 共用 TypeScript 类型、验证和错误协议。
- Node.js 主线程只处理 I/O、认证、编排和轻量业务逻辑；CPU 密集转换、脚本、仿真和分析进入有界 `worker_threads` 池、隔离进程或插件任务。
- Revit 正式接入继续使用 `tools/revit-worker` 下的 C#/.NET Add-in 与 Worker。Python `revit-agent` 脚本明确标记为辅助/兼容路径，完成 C# 能力对齐后评估删除，不作为正式部署必需项。
- Tauri Rust 不承载第二套业务 Core、文档模型或 API 客户端；相同 TypeScript Studio Core 与 UI 在浏览器和 Tauri 复用。
- M8 首版使用纯 TypeScript `SimulationEnginePort` 实现。只有持续基准证明无法达到目标，才增加可选 Rust/WASM/原生实现，并要求通过相同协议、黄金样本和确定性门禁。
- Python 只能因明确库/训练需求按插件或离线任务引入；输入输出必须是版本化文件/消息协议，依赖打包、资源预算、日志和失败清理由插件负责。

## Interop rules

- 跨语言边界只传 JSON/JSON Schema、二进制资产、内容哈希和明确版本的任务消息，不共享进程内对象。
- TypeScript contracts 是网络/进程协议的权威源；需要 C# 或其他语言时由 Schema 生成 DTO，或用合同测试验证手写 DTO，不并行手工发明第二份语义。
- 错误统一包含稳定 code、用户消息、诊断详情、retryable 和 correlationId；不得把 Python traceback、Rust panic 或 .NET exception 直接暴露给用户。
- Sidecar/Worker 必须声明版本、capability、输入输出格式、超时、取消和资源上限；服务器在执行前完成兼容协商。
- CI 按实际宿主构建和测试，不要求未使用可选插件的部署安装 Python、Rust toolchain 或 Revit SDK。

## Consequences

### Positive

- 主产品绝大部分代码使用一种语言，前后端契约和开发体验统一。
- C#、Rust 和 Python 只出现在它们真正有平台优势的边界。
- 单服务器部署保持简单，可选能力不会扩大默认运行依赖。
- 高性能任务仍有 Worker、原生 sidecar 和 WASM 的升级出口。

### Negative

- TypeScript 对部分数值计算的峰值性能低于 Rust，需要用基准而非假设决定优化。
- C# Revit Worker 与 TypeScript contracts 需要跨语言合同测试。
- 可选 Python 工具必须单独处理解释器和依赖打包，不能假设目标机器已安装 Python。

### Neutral

- Tauri 工程仍包含 Rust，但业务功能和 UI 不因此迁移到 Rust。

## Alternatives considered

**Python 作为主后端**：拒绝。Python/FastAPI 可以实现 API，但当前项目会失去前后端 TypeScript 契约复用并产生大规模重写；项目也不是以 Python AI/科学计算为主体。

**Rust 作为主后端和仿真强制依赖**：拒绝。性能潜力高，但会增加当前团队、插件和部署复杂度；只在基准证明必要的边界使用。

**所有能力都用 TypeScript**：拒绝。Revit 官方 Add-in 适合 C#/.NET，Tauri 原生层需要 Rust，强行统一会绕过官方生态或增加不可靠桥接。

**Python 直接驱动 Revit 作为正式主路径**：拒绝。正式 Add-in 使用 Autodesk 支持的 C#/.NET API；Python 仅保留明确的辅助/兼容任务。

## Failure modes

| Failure | Impact | Mitigation |
| --- | --- | --- |
| 主线程执行 CPU 重任务 | API/WebSocket 卡顿 | 有界 Worker 池、任务队列、超时和取消 |
| 多语言 DTO 漂移 | 转换或发布错误 | Schema、代码生成/合同测试、版本协商 |
| 可选运行时缺失 | 插件无法执行 | manifest 预检、按需安装、清晰降级，不影响核心 |
| Sidecar 崩溃 | 当前任务失败 | 进程隔离、结构化诊断、清理和安全重试 |
| 过早原生优化 | 维护成本增加 | 性能基准与 15% 回归门禁后再决定实现 |

## References

- [Node.js Worker Threads](https://nodejs.org/api/worker_threads.html)
- [Autodesk Revit API FAQ](https://help.autodesk.com/cloudhelp/2026/ENU/Revit-API/files/Revit_API_Developers_Guide/Revit_API_Revit_API_Developers_Guide_FAQ_html.html)
- [Tauri 2 Commands](https://v2.tauri.app/develop/calling-rust/)
- [ADR-0002 模块化编辑器内核](./0002-modular-editor-core.md)
- [ADR-0008 工厂物流仿真插件](./0008-factory-logistics-simulation-plugin.md)
