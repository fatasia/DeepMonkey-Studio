# Deep Engine 后续开发与发布方案

**版本**：2026-09-15

**用途**：本文件是 Deep Engine 下一轮开发的唯一执行入口。按阶段完成、按门禁验收；已关闭的 GLM 任务不重复实现。

**任务拆解**：[后续开发任务清单](deep-engine-next-development-tasks-2026-09-15.md)。按该清单的依赖顺序领取任务；本文件保留范围与发布目标，任务清单补充当前代码核对、验收条件和命令修正。

## 1. 目标

把 Studio 中编辑的二维、三维场景发布为可验证的客户端交付物：

1. Three WebView 交付保持现有兼容性和稳定性。
2. Deep Native 交付使用原生 wgpu 播放器，最终可以生成 Windows 独立客户端，不依赖 WebView。
3. 场景内容、二维看板、资源、动画、交互和数据绑定有明确的兼容矩阵；不支持的能力在发布前阻断或明确降级。
4. 性能和视觉结论只来自同一设备、同一资产、同一轨迹、同一分辨率、同一画质策略的可复现实测。
5. 目标门槛：BIM 资产正确性优先，视觉效果可对照，性能达到 Unity 6 原生基准的 90% 以上，并在同条件下超过 Three/Babylon；没有证据就不宣称达标。

## 2. 当前架构与发布边界

```text
Studio 编辑器（WebView）
  ├─ Three.js 场景图、相机、拾取、选择、测量、剖切、数据绑定
  ├─ Three WebGL（当前稳定作者画布）
  └─ Deep WebGPU bridge（同一状态的高性能渲染后端）

发布
  ├─ Three WebView：现有只读场景客户端/网页发布链路
  └─ Deep Native：SceneSnapshot → RenderPacket + Deep2D runtime-package → 原生 wgpu 播放器 → Windows EXE
```

编辑器继续运行在 WebView。Deep Native 是**发布运行时目标**，不是编辑器替换，也不应把 Deep WebGPU bridge 的能力误写成原生客户端已经具备的能力。

当前发布对话框已提供：

- 仅发布；
- Three WebView；
- Deep Native。

页面当前下载 `.bimscene.zip` 交付包，包含场景、二维应用、资源、绑定、数据运行时描述和脱敏清单。它是发布输入包，不等于已完成的独立 EXE；EXE 生成、安装、签名和更新属于本方案的后续生产门。

## 3. 已完成项

### 3.1 Studio 与 Web Deep

- Deep WebGPU bridge 已接入场景模型、相机、环境、灯光、阴影、LOD 和编辑器覆盖层。
- 相机、拾取、选择、高亮、测量、标注、剖切、BIM 放置等编辑器能力继续由宿主 Three/Studio 负责；Deep 画布接收同一状态投影。
- RAF、render-demand、revision 追赶、失败回退、资源回收和 overlay 投影已有 focused 测试。
- 浏览器产品门已覆盖 1440/1366/1024 视口、WebGL 和 WebGPU。

### 3.2 Deep Engine 内核

- Web：MRT/HDR、PBR/IBL、Forward+、CSM、GTAO、TAA、OIT、Bloom、ACES、GPU LOD、meshlet、Hi-Z、indirect draw、分块流式和粒子模块。
- Native：wgpu 3D 前向 HDR、PBR、IBL、CSM、Bloom、ACES、单剖切平面、GPU LOD/剔除、Deep2D painter、材质 ABI 和 runtime package 合同。
- Native RTX 4060/Vulkan 的 GPU culling、LOD/history/residency、indirect draw+CSM、Deep2D、DPI、百万点专项和 portable smoke 已有真机证据。

### 3.3 GLM 已交付，不重复做

- P3：Deep2D 控件显示列表、原生 UI 样机帧、图表尺度/布局/交互/百万点管线、选区联动、glyph atlas 增量、CPU 参考光栅化、IME 适配、DPI 矩阵。
- P4-A：RT 能力探测、厂商矩阵、降级原因和 feature flag 合同。
- P4-B：RT 阴影优先的实验设计和 benchmark 规格；未宣称生产 RT。
- 相关终态：GLM 报告中的 CPU/集成/真 GPU 测试与 4060 Vulkan 证据作为现有基线使用。

### 3.4 已知有效证据

- Deep Engine：331 个测试文件，2702 passed、41 skipped；typecheck/build/scanner/purity 通过。
- Web：全量测试 2690 passed、2 skipped；发布对话框、发布动作、文档测试通过。
- Unity：Unity 6 D3D11 + RTX 4060 有效渲染记录；Unity Vulkan 因 shader package 缺失暂不能做等价比较。
- Three WebGPU 的历史报告显示本项目中存在高尾帧和重建堆增长；该结果只能作为风险输入，不能替代 Deep 与 Unity 的同条件基准。

## 4. 真正剩余任务

### P0：发布正确性与门禁

1. 修复当前 source-size 门禁：`apps/web/src/App.tsx` 和 `apps/web/src/hooks/useAppRuntimeEffects.ts` 超过 800 行。拆分后重新运行仓库门禁。
2. 建立发布前兼容检查：模型资源、材质、纹理、动画、二维页面、绑定、交互、数据连接逐项输出 `supported / degraded / blocked`。
3. 发布包必须有稳定 manifest、版本、内容 hash、资源 hash、renderer、feature flags、降级原因和构建证据；包损坏或版本不匹配必须拒绝启动。
4. 发布动作失败时保留发布版本，页面显示失败原因并允许重试打包；不得出现“发布成功但包未生成”的无状态结果。

### P1：SceneSnapshot → Native Runtime Package

这是 Deep Native 从 demo 变为产品的核心任务。

1. 编写确定性转换器：`SceneSnapshot` 的模型、实例变换、材质、纹理、环境、灯光、阴影、相机、动画和剖切状态转换为 `RenderPacket v1` 与 Native runtime package。
2. 资源处理：GLB/自包含格式、纹理、环境贴图、材质槽、mip、压缩格式和大小预算；无法转换的资源在发布前给出具体对象和原因。
3. 坐标处理：实现 BIM 大坐标的 floating origin/局部原点策略，保持测量、拾取、阴影和相机轨迹的数值一致性。
4. 3D 播放器接入动画、透明、剖切、相机状态、选择状态和场景更新；验证设备丢失、资源缺失、坏包和恢复矩阵。
5. 2D 播放器接入 retained UI、图表、文本、命中测试、事件和多页面；不能只通过 painter 库测试冒充产品完成。
6. Native 与 Web 的视觉合同：同一场景导出截图，比较几何覆盖、材质、透明、阴影、色调映射、文字和二维布局；逐项允许明确差异。

### P1：数据连接与网络运行时

1. 发布包保留连接类型、数据集、流水线、绑定和刷新策略，但不写入密码、令牌、请求头、签名 URL 或数据库凭据。
2. 定义客户端运行时配置文件和安全注入方式；部署时由环境变量、凭据存储或管理员配置注入。
3. 明确连接矩阵：`sim:` 可离线随包运行；HTTP、WebSocket、PostgreSQL 等外部连接需在目标机器重新配置并通过健康检查；不支持的连接发布前阻断。
4. Native 运行时实现数据拉取、重连、超时、取消、离线缓存和错误状态，并驱动二维组件与三维绑定。
5. 网络不可用时，场景仍可按策略进入离线浏览；数据组件显示“连接不可用”和最后更新时间，不伪造实时数值。
6. 增加发布包数据安全测试：凭据扫描、越权读取、断网、超时、重连、脏数据、版本不匹配和连接删除。

### P2：正式场景性能与视觉

1. 把 GPU LOD、meshlet、Hi-Z、indirect draw、chunk streaming、residency 和动态质量档位接入 Native 正式场景生命周期。
2. 建立三套真实 BIM fixture：工厂、电站、仓储；每套至少 50 万三角形、200 个实例、真实纹理和多材质，并固定 hash。
3. 浏览器 Deep、Native Deep、Three WebGL、Three WebGPU、Babylon（隔离环境）和 Unity 6 使用同一资产/轨迹/分辨率/画质策略。
4. GPU 时间使用 timestamp query；host wall time 单独记账。低于计时器分辨率的差异不得用于性能排名。
5. 视觉门覆盖：PBR/IBL、透明、阴影、ACES、TAA、AO、Bloom、雾、天空、二维布局、文字和高 DPI；每项输出像素差异和可接受阈值。
6. 直接影响 BIM 资产正确性或性能的优化优先：floating origin、资源解码、LOD 可见性、剔除漏绘、纹理/mip、透明排序、数据绑定刷新。
7. 只有在基准证明吞吐、画质或稳定性收益后才纳入默认管线；否则保留为实验开关。

### P3：客户端工程化

1. 将 Deep Native runtime package 接入原生播放器正式入口，支持窗口输入、相机、拾取、测量、剖切、选择高亮、二维页面和数据状态。
2. 完成原生资源包离线运行、缓存、增量更新、崩溃恢复和 last-known-good 回退。
3. 提供 Windows x64 构建、安装器、签名、版本升级和卸载验证；portable 包和 installer 都要有 SHA-256 与 manifest。
4. 页面发布完成后显示：发布版本、目标运行时、包状态、下载入口、hash、资源数量、连接重配置数量、降级/阻断项。
5. Three WebView 与 Deep Native 的切换只发生在发布目标选择；编辑器入口不改变，用户可从同一场景重新发布另一目标。

### P4：Native RT（不阻塞 P0–P3）

- 保留现有 `rt_probe` 和 RT 阴影实验设计。
- wgpu 暴露正式 RT API 前不引入 fork 或未经批准的底层依赖。
- 4060 仅在能力探测通过后执行 RT benchmark；否则记录 `unsupported/backend-lacks-rt-api` 并使用光栅 fallback。
- RT 只有在阴影质量、GPU 时间和 20 分钟稳定性同时超过 CSM/PCF 基线后才进入生产开关。

## 5. 发布包兼容矩阵

| 内容 | Three WebView | Deep Native 当前 | Deep Native 生产门 |
|---|---|---|---|
| 三维模型/实例 | 现有发布浏览器 | RenderPacket/runtime package 输入 | SceneSnapshot 自动转换、资源 hash、真实场景验证 |
| PBR/纹理/环境 | Web 管线 | Native ABI/固定资源 | GLB/纹理/mip/压缩格式矩阵和视觉对照 |
| 二维看板 | Web 应用页面 | Deep2D painter/合同层 | 页面、图表、文字、事件在 PlayerContent 中运行 |
| 交互 | WebView 宿主 | 原生播放器模块 | 相机、拾取、测量、剖切、选择、高亮完整回归 |
| 动画 | Web 运行时 | 部分底层模块 | TRS/morph/skinning 播放与轨迹对照 |
| 数据绑定 | Web 连接运行时 | 描述已进包 | Native 连接、重连、离线和安全注入 |
| 外部凭据 | 服务端/浏览器配置 | 不进入包 | 客户端安全配置和健康检查 |
| 独立 EXE | Tauri/WebView | 原生 wgpu 入口 | 构建、安装、签名、更新和恢复全通过 |

发布前只要有一项为 `blocked`，发布动作必须阻断；`degraded` 必须显示具体对象、原因和替代路径。

## 6. 验收门禁

### Gate A：工程门禁

```powershell
pnpm gate:deep-engine-editor
pnpm --filter @bim-studio/web test -- --run
pnpm gate:repository
```

要求：typecheck、Deep Engine 全量测试、Web 全量测试、source-size、纯度、构建和文档链接全部通过。

### Gate B：发布包门禁

```powershell
# 页面：选择场景 → 发布 → 客户端打包 → 下载 .bimscene.zip
pnpm --filter @bim-studio/desktop test:scene-viewer
pnpm --filter @bim-studio/deep-engine-native test
pnpm --filter @bim-studio/deep-engine-native verify:portable
```

要求：manifest/hash/资源引用正确，坏包拒绝启动，凭据扫描为零，Three WebView 与 Deep Native 目标不混淆。

### Gate C：真实 GPU 与视觉

固定 RTX 4060、驱动、后端、窗口尺寸、DPR、资产 hash、相机轨迹、灯光和质量档位。输出：

- GPU timestamp p50/p95/p99；
- CPU、显存、draw、triangle、visible/drawn、resident/dropped；
- 视觉 SSIM/像素差/几何覆盖；
- device loss、重连、恢复和 20 分钟稳定性；
- 所有降级原因。

### Gate D：Unity/竞品对标

Unity 6 使用原生 D3D11/Vulkan 渲染场景；Three/Babylon 使用隔离项目。对标报告只比较同条件结果。`-nographics`、host-only wall time、不同资产或不同画质不得进入排名。

## 7. 开发顺序

1. 先修工程门禁和发布包状态模型。
2. 完成 SceneSnapshot → RenderPacket/Deep2D runtime package 转换与资源校验。
3. 接通 Native Player 的三维、二维、交互和数据运行时。
4. 完成离线/网络安全、恢复、安装器和页面产物展示。
5. 用真实 BIM fixture 做 GPU/视觉基准，修复资产正确性和性能问题。
6. 再做 Unity 6、Three、Babylon 对标，达标后决定默认发布目标。
7. P4 RT 保持隔离，只有真实收益证据齐全才提升为生产功能。

## 8. 每个任务的完成定义

一个任务只有同时具备以下内容才算完成：

- 代码接入正式路径，不是孤立 demo 或库级探针；
- 兼容矩阵已更新，支持/降级/阻断行为明确；
- focused test、相关全量测试和真实运行检查通过；
- 有可复现的 GPU/视觉/稳定性证据，或明确记录无法测量的原因；
- 文档、发布 UI、错误信息和产物 manifest 同步；
- 不把 GLM 已完成工作重复实现，不把设计文档写成生产能力。

## 9. 当前结论

之前规划的大量内核、P3/P4 合同和编辑器接线已经完成，剩余工作集中在“合流成正式发布运行时”：场景快照转换、Native 三维/二维/交互/网络运行时、独立 EXE 工程化、真实 BIM 基准和最终视觉/性能门禁。页面上的 Three WebView 与 Deep Native 选项已经就位，但在 Deep Native 生产门通过前，不能把下载的 `.bimscene.zip` 或现有原生探针称为完整客户端。
