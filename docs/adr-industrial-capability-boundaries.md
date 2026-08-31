# ADR：工业能力插件与 AI/MCP 边界

状态：Accepted（2026-08-28）

## 决策

1. 插件只通过 `capability.provider` 暴露可审计能力；Manifest 不携带可执行代码或下载地址。
2. 能力调用统一经过 `CapabilityRegistry`，由运行时处理权限、超时、取消、结构化错误、trace 和证据。
3. 预测维护复用现有 `OperationsService`，不复制数据集、权限或模型生命周期。
4. 虚拟调试采用 TypeScript Worker/Node Worker 友好的确定性内核；不引入 Rust sidecar、第二套现场协议驱动或 3D 编辑器。
5. MCP 只做工具发现/调用适配，不能绕过项目边界和能力运行时。
6. 电池能力保持双轨：标准模型与电热基线拥有主输出权；PINN/PINO/TwinMoE 正常执行影子推理、路由、比较和审计，生产流量为 0；SPM 负责域外安全回退。
7. AI 模型运行时通过 `ai.provider` 插件注册。宿主只传入当前请求所需配置，Manifest、能力目录和日志均不得保存 API Key。
8. 助手从 Capability Registry 发现领域能力；能力目录不等于执行证据，只有结构化 `CapabilityInvocationResult` 可以作为已执行事实。

## 后果

- 页面、SDK、MCP 和自动化可以复用同一能力，不再各自实现错误处理。
- OpenAI 兼容、本地模型或企业模型网关可以替换，助手路由不再硬编码厂商协议。
- 领域算法可在 Worker、服务端或后续远程执行器之间替换，UI 不需要改协议。
- 需要为每个生产模型维护模型卡、黄金样本、回放证据和发布门禁；研究代码不能直接覆盖生产输出。
