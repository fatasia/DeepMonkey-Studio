# ADR-0005: WebGPU 优先、WebGL 2 兼容的渐进渲染策略

## Status

Accepted

## Context

Dev Studio 需要长期支持复杂材质、工业特效、粒子、实例化和 GPU 计算，同时必须兼容现有 Three.js/WebGL 场景和不同浏览器、WebView、GPU 与驱动。

Three.js `WebGPURenderer` 优先使用 WebGPU，并可以回退 WebGL 2；其新材质与后处理体系采用 TSL/Node Material。但是当前官方仍将 WebGPU renderer 标为实验状态，旧 `ShaderMaterial`、`RawShaderMaterial`、`onBeforeCompile` 和 `EffectComposer` 不能直接迁移。

## Decision

- 架构和新渲染代码 WebGPU/TSL 优先，WebGL 2 作为必须保留的兼容后端。
- 采用三阶段发布：
  1. 重构期 WebGL 2 为生产默认，WebGPU 通过实验开关启用；
  2. 核心能力、视觉回归和兼容矩阵达标后，Auto 成为默认；
  3. 稳定期新材质、后处理和适合的 Compute 能力优先使用 WebGPU/TSL。
- 建立 Renderer Port；场景文档、脚本、动画、选择和业务仿真不依赖具体 GPU 后端。
- Auto 模式探测 WebGPU、设备能力和项目需求；不满足时回退 WebGL 2。始终保留强制 WebGL 2 模式。
- 旧 WebGL 材质和 EffectComposer 保留兼容路径并提供迁移诊断；不能静默删除效果。
- 插件、材质和后处理声明 `webgpu`、`webgl2` 或 `both` 以及降级策略，发布前校验。
- WebGPU 优化优先应用于实例化、粒子、数据驱动效果、MRT 后处理和经过基准验证的 Compute 任务；不为使用 WebGPU 而迁移普通 CPU 业务逻辑。

## Non-Functional Requirements

- WebGPU 初始化或设备丢失时可以恢复或回退，项目编辑状态不得丢失。
- WebGPU/WebGL 2 对相同黄金场景执行截图、拾取、动画、交互和性能回归。
- 后端切换不改变对象 ID、脚本语义、数据绑定和确定性仿真结果。
- 发布包记录渲染能力要求和实际降级原因；不可兼容时发布失败并定位到材质、效果或插件。
- B/S 与 Tauri 分别执行真实设备能力探测，不根据 User-Agent 猜测。

## Consequences

### Positive

- 获得 WebGPU、Compute、TSL 和现代后处理的长期演进空间。
- 保留 WebGL 2 覆盖面和现有项目兼容性。
- 一套场景业务逻辑可以在两种后端运行，并为最终云渲染保持清晰边界。

### Negative

- 迁移期需要维护 WebGL 兼容路径和双后端测试矩阵。
- 旧自定义 Shader 与后处理需要逐步迁移到 TSL，不能自动转换。
- WebGPU 在不同 GPU/驱动上的差异会增加视觉和性能验证成本。

### Neutral

- “WebGPU 优先”是新代码和长期方向，不等于首个重构版本强制所有用户使用 WebGPU。

## Failure Modes

| Failure | Impact | Mitigation |
| --- | --- | --- |
| WebGPU 初始化失败/设备丢失 | 三维视口中断 | 保存编辑状态、重建 renderer、必要时回退 WebGL 2 |
| 旧 Shader 不兼容 | 材质或特效缺失 | 能力扫描、WebGL 兼容路径、迁移诊断与发布阻止 |
| 双后端画面差异 | 编辑预览和发布不一致 | 黄金截图、容差基线、色彩空间/精度统一和人工审批 |
| WebGPU 反而更慢 | 特定设备性能下降 | 设备级基准与遥测、Auto 决策和强制 WebGL 模式 |
| 插件只支持单后端 | 项目无法回退 | manifest 声明、替代效果或发布前明确阻止 |

## Alternatives Considered

**只支持 WebGL 2**：拒绝。限制 Compute、现代材质/后处理和长期性能演进。

**立即强制 WebGPU**：拒绝。官方实现仍有实验性边界，旧 Shader/后处理和部分设备无法无损迁移。

**分别维护 WebGPU 与 WebGL 两套场景逻辑**：拒绝。代码量、行为差异和测试成本不可控。

## References

- [Three.js WebGPURenderer 文档](https://threejs.org/docs/pages/WebGPURenderer.html)
- [Three.js WebGPURenderer 迁移指南](https://threejs.org/manual/en/webgpurenderer)
- [Three.js WebGPU 后处理](https://threejs.org/manual/en/webgpu-postprocessing.html)
- [Dev Studio 产品与架构规划](../dev-studio-product-and-architecture-plan.md)
