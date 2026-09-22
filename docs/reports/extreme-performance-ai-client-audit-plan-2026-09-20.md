# 极致性能、效果、AI 底座与双客户端交付：现状审计和执行批次（2026-09-20）

## 1. 执行口径

本报告以当前主工作树为权威。专项原计划使用独立 worktree，是为了避开同时修改原工作区的另一主线程；用户已停止该任务并把范围统一到当前主线程，因此不再创建一个缺失当前未提交成果的副本。保留全部共享 WIP，不 reset、clean、checkout 或 push。

完成只按端到端链路计算：`用户入口/产品策略 → 保存与撤销 → 编译/冻结 → Web/Native/Three WebView 消费 → 真实交互 → 证据`。只有内核、schema、导出 helper 或单元测试不算产品完成。

用户最新调度：功能接入阶段停止重复全量、长性能矩阵和广域视觉测试，只保留避免阻断后续开发的最小编译/定向检查；完整测试、截图和性能对比统一进入批次 F。

状态定义：

- **已实现并接入**：产品路径真实消费，关键回归通过。
- **内核就绪、未接入**：实现存在，但正式用户路径不可达。
- **已接入、待终验**：产品链存在，缺同条件真实客户端或性能/视觉证据。
- **真正缺失**：当前代码没有可复用实现，需要新增设计和实现。

## 2. 当前基线

| 领域 | 当前状态 | 权威证据 / 边界 |
|---|---|---|
| R10 Physics | 已实现并接入 | Web/Native PhysicsWorld、Impulse/Multibody、保存/编译/运行闭环；physics-validate 19/19；Native 真窗口证据 `test-output/native-physics-window-smoke-20260920/evidence.json`。真实 torque cap 仍不支持 |
| R12 render-loop / Source Map | 已接入、待补资源快照 | 真 render-loop、PBR provenance、Studio 查询 UI 和四场景真 GPU 已通过；通用 buffer/texture snapshot/readback 未完成 |
| R1 Surface Cache / DDGI | 内核就绪，产品接入进行中 | RenderPacket 动态脏域和 GPU irradiance history 已实现；正式 PBR/Studio 生命周期挂载正在补 |
| R4 clustered / Hi-Z / indirect | 已实现并接入，待整帧收益 | 64-lane clustered compute、previous Hi-Z meshlet cull、indirect draw 已接；万灯/遮挡正确性和整帧收益仍需同场景测量 |
| R9 / G3 | 部分接入 | meshlet 路径为产品策略；分区 bounds HLOD 已进入 bake/residency/GPU LOD 内核，但正式产品配置和显存逐出未闭环 |
| C3 增量与 PSO | 已实现并接入 | texture/grid/LOD zero-write、Deep2D batch、PBR PSO cache 和预算降级均已进入真实热路径 |
| E02 IES | GPU 双端已接，作者链进行中 | Web/Native shader 已消费；SceneLightState、保存、编译和正式编辑入口正在补 |
| E04 SSR / E05 PCSS | 内核就绪、作者链缺失 | SSR roughness filter、Spot PCSS/稳定偏置真实运行；缺正式 Scene state、Studio 参数、编译和 Native 对等链 |
| R11 动画状态机 | Web 已闭环、Native 部分 | 正式 Web Viewer 已消费 v2/v3 runtime；Native 仍缺 clip 动画宿主调用 |
| P5 / P7 | Web 产品入口可用、保存语义不完整 | 空间校验/QTO 可计算和导出；规则、分类口径、结果定位与发布语义仍需补 |
| AI / MCP | 已有底座，尚未完成本轮产品审计 | 复用 `/api/mcp`、Capability Registry、agent gateway、审批/证据和 SceneCommandTransaction；禁止创建第二套 MCP |
| Deep Native / Three WebView 发布 | 历史修复存在，需完整重验 | 必须从真实发布入口验证 EXE、完整页面、多页面交互、离线依赖、无多余控制台，不复用旧“只有 JSON/assets”结论 |
| Web / Native 视觉 | 当前固定样本通过 | 2D SSIM 0.9816–0.9913；3D GI-on 0.994162、GI-off 0.997363；只证明当前固定包接近一致，不覆盖完整页面 |
| Web / Native 性能 | 进行中 | 首批 Bloom 配置不等价已废弃；10,000 实例相同配置的 5 轮冷/热采样正在重跑 |
| 3D 背景网格 | 待审计 | 已有渲染网格和清晰度修复，但场景元素、显隐、保存、撤销、编译和双客户端链必须逐层核实 |
| Native LPAC | 待环境/链路修复 | 非 LPAC 1374 项 0 失败；13 项 worker 在本机统一退出 `0xc0000022`，不能签核为通过 |

完整逐能力消费矩阵见 [主线底层能力到产品消费审计](mainline-product-consumption-audit-2026-09-20.md)。

## 3. 执行批次

### 批次 A：收完当前在途项

1. 完成 10,000 实例 Web/Native 同配置性能对比；记录 CPU/GPU/frame P50/P95/P99、长帧、吞吐、显存、冷/热启动。配置不等价的数据一律作废。
2. 把 R1 Controller 挂入正式 Deep PBR/Studio 生命周期，覆盖 feature-off、replace、device loss 和 dispose。
3. 把 E02 IES 接入正式 SceneLightState、编辑、保存、撤销、编译和双端发布。

关闭条件：focused、类型检查、真 GPU/客户端证据齐全；不得只增加导出或开关。

### 批次 B：高收益产品断点

1. E04 SSR 和 E05 PCSS 的 Scene 状态、Studio UI、保存/撤销、编译及 Web/Native 能力矩阵。
2. G3 产品 HLOD 策略与真实 residency/eviction；选中、测量、属性对象保持高质量和稳定 ID。
3. R11 Native clip 动画宿主；P5/P7 规则与分类口径持久化、结果定位。
4. R12 有预算的资源 snapshot/readback，历史帧资源不得误复用。
5. 3D 背景网格正式场景元素：辅助/发布语义、显隐、参数、保存、撤销/重做、编译、Web/Native/Three WebView 一致消费。

### 批次 C：性能结构优化

1. Forward+ 先测 cluster 候选规模、CPU 提交和 GPU 时间，再决定灯 bounds 预计算/粗分桶；保留小场景低成本路径和确定性 overflow。
2. 两阶段遮挡只在“不漏绘”验证充分后启用；透明、薄片、运动、新显露和阴影 caster 单独处理。
3. RenderGraph 帧内 transient reuse / MRT 裁剪 / pass fusion 必须以生命周期分析和带宽数据驱动；历史/readback 禁止 alias。
4. 静态场景按变化驱动降频；动画、物理、告警、视频、TAA 和输入均可正确唤醒。
5. HLOD/流式优化同时验证显存实际下降，而不是只降低远景三角形。

### 批次 C2：极致引擎主干（本轮新增，纳入正式验收）

这些项目不是研究备忘，按依赖进入本轮实现。现有 meshlet、bounds HLOD、跨帧 transient pool、PSO cache、KTX2/Basis、TAA、DDGI/SSR 内核继续复用；只有产品链和运行消费闭环后才记为完成。

1. **分页虚拟几何与显存流送**：建立稳定页 ID、页表、可见性需求、I/O/解压/上传预算、优先级、逐出和 last-good 事务；CPU 作者几何与 GPU residency 分离。选中、拾取、测量、属性和工程精度不能因分页降级。bounds HLOD 或原始几何全驻留不算完成。
2. **RenderGraph 帧内 alias 与带宽**：基于 pass 生命周期证明兼容 texture/buffer 可复用，历史帧、readback、外部资源和并发访问资源显式排除；裁掉无消费者 MRT，合并只在带宽与同步收益可测时启用。浏览器 WebGPU 资源复用与 Native 底层内存 alias 分别记录。
3. **Native 多线程编码**：复用现有确定性 scheduler，把可并行 command encoder 真正分派到 executor；资源准备、pass 依赖、提交次序、错误取消和设备丢失保持确定性。Promise 并发不作为 CPU 并行证据。
4. **bindless / 材质参数池 / 大规模纹理虚拟化**：先记录 bind group、PSO、CPU submit 和纹理 residency 成本；按设备 limits 分级启用参数池、纹理数组或 bindless。保留非 bindless 小场景路径，虚拟纹理需有真实页驻留与逐出，不能只做 atlas。
5. **相机相对坐标与分块世界**：统一 Web、Native、物理、拾取、测量、剖切、动画和历史缓冲的坐标帧；明确 double 作者坐标、chunk/local GPU 坐标和 origin rebasing revision。CAD 工程公差、硬边、薄结构与稳定对象 ID 为硬门槛。
6. **反射与间接光层级**：SSR 有效命中 → 完整粗糙锥追踪 → 局部视差校正 probe → 必要平面反射 → 环境回退，避免重复镜面能量；增强 DDGI/Surface Cache 更新、遮挡和泄漏控制。多灯接触阴影、PCSS、体积效果进入同一历史有效性体系。
7. **共享时域可信度**：复用现有 TAA，不重造抗锯齿；统一提供 motion、disocclusion、材质/灯光 revision、曝光与 reactive mask，各效果独立判定历史是否可用。文字、Dashboard、gizmo 和选中轮廓不得被时域模糊。
8. **设备自适应与线上遥测**：以设备 limits、分辨率、内容复杂度、CPU/GPU P95/P99、显存和长帧自动选择画质，带滞回、预算和用户覆盖；遥测默认有界、去敏、可关闭，用真实热点反哺策略，不能用降分辨率或漏效果冒充优化。
9. **生产管线成熟度**：Shader/DCIR 内容寻址增量编译、取消、后台预热、PSO/资源缓存、静态场景按需渲染和变更唤醒进入正式产品；缓存身份包含设备/驱动/schema/feature，失败保持 last-good。

依赖顺序：坐标帧合同与页身份 → 虚拟几何/residency → RenderGraph 生命周期与 Native executor → 材质/纹理分页 → 共享历史可信度 → 反射/DDGI/阴影/体积 → 自适应遥测 → 内容与 Shader 生产管线收口。批次 F 统一给出同画质 CPU/GPU/显存/启动/包体证据。

当前实现检查点（广域验收后置）：

- Studio 已将大型静态几何切为内容寻址 meshlet pages，进入相机可见需求、页级上传/逐出与 last-good residency；小场景、变形、骨骼和作者 LOD 保留低成本路径。GPU feedback、mega-buffer/稀疏绑定仍待。
- Web Deep 已以 `scene-local-coordinates-v1` 提供带滞回的 camera-relative frame，作者世界坐标保持 double，GPU packet/view 使用局部 float；Native 动态导航 rebase 正在补。
- 共享 temporal validity 已覆盖 TAA/SSR/DDGI/雾/接触阴影，SSR 已升级为最多六层 GPU radiance pyramid + roughness LOD cone sample，并避免与 probe/environment 回退重复叠能量。
- MCP 已新增独立设置入口、短 TTL 活跃编辑器 presence、分页 `resources/list/read`；下一步继续语义查询、写事务与外部客户端验收。
- RenderGraph 编译期 alias slot 已存在；实际 PBR 帧内物理资源复用与无用 MRT 分配裁减正在接线。
- Native 动态导航 rebase 已按 ±750 滞回和 1000 单位网格原子迁移 GPU 场景、相机、Rapier、选择与标注；作者世界坐标和发布包 hash 不变，失败完整回滚，拾取/测量保持 world f64。
- RenderGraph 已让兼容 transient texture 按生命周期和 happens-before 真实共享物理分配，并将无消费者的 geometry MRT 从 5 个裁为 2 个；历史、外部、readback、并发资源和捕获帧显式排除。
- 设备自适应已真实驱动 SSR 锥层级、雾步数、DDGI 更新预算和 LOD 细节，包含压力/恢复双滞回、冷却、用户覆盖和最多 16 条本地去敏热点摘要；默认关闭，无远程发送。shadow/residency 的自动预算仍待安全接线。
- 内容寻址 Shader 生产链已把 runtime package 的 shader-pipeline 预热接入真实设备级 `ShaderPackageExecutor`，支持取消/supersede、last-good 和 cache hit/miss/compile/abort/failure/eviction 统计。
- R12 已补 bounded COPY_SRC buffer 与非压缩 2D texture readback 内核，包含 256B 行对齐剥离、区域/预算/设备上限校验和取消/超时/device-loss 清理；尚未接入 PBR 安全资源白名单与 Studio 产品入口。
- MCP 已增加对象语义、选择集和 application 空间导航三类分页资源，URI 同时绑定 editor session、draft revision 与 persisted revision，TTL/权限/revision 漂移均 fail-closed；当前明确读取持久化编辑器基线，未保存草稿镜像和浏览器写事务 driver 仍待接入。
- 场景网格已从作者 `gridVisible` 贯通 Three scene.json 与 Deep Native RenderPacket：网格与 skybox 独立，开启时生成 4 层 unlit/BLEND 辅助几何（804 triangles、4 draw instances、低于 64KB），关闭时零几何/零 draw；最终真实客户端的保存/撤销/多 DPR 清晰度回归后置到批次 F。

### 批次 D：AI / MCP 产品闭环

1. 设置中心新增独立 MCP 栏目，真实展示 endpoint、认证、可用能力、权限/审批语义、客户端 JSON、连接检查和最短接入步骤；复用 `/api/mcp`，不新建服务。
2. 审计现有 `/api/mcp`、Capability Registry 和 SceneCommandTransaction，输出工具/资源/权限/annotation 矩阵。
3. 增加分页场景语义查询、选择集、空间关系和小摘要资源；禁止整场景塞入上下文。
4. 编辑工具统一复用 UI 命令与 prepare/apply/rollback，绑定活跃编辑器会话、draft revision、确认、幂等和并发冲突。
5. 提供截图、对象 ID/深度、性能画像和验证结果，形成有预算的观察→编辑→测量→修正流程。
6. 用真实外部 MCP 客户端验证协议和不可信内容边界，不以内部注入测试代替。

### 批次 E：完整双客户端交付

1. 从真实发布入口生成 Deep Native 与 Three WebView 完整客户端；解压后直接启动，EXE/资源/字体/运行时依赖齐全，无多余控制台窗口。
2. 使用真实多页面项目覆盖 3D、Dashboard、路由、导航、图表、脚本、数据绑定、相机、环境、灯光、后处理、动画和物理。
3. 实际操作旋转/缩放/平移、拾取/选择、属性、显隐、剖切、测量、页面切换、按钮/图表事件、动画、脚本和数据交互。
4. 重放历史失败：缺 EXE、长时间无反馈、云 Worker/token 误依赖、运行证据缺口、页面/脚本依赖诊断。
5. 同相机、分辨率、DPR、质量档做网页/双客户端视觉与性能对比；不能靠降画质证明性能。

### 批次 F：最终门禁

- repository / 800 行 / public-brand；Web、API、Studio Core、Deep、Native 全量；严格 300 行债单独治理。
- 保存样本哈希、构建版本、运行日志、截图、交互步骤和性能 JSON。
- 两轮真实浏览器/Native 视觉闭环；按 `design-taste-digitaltwin` 的 Kimi-95 十维标准签核编辑器、网格和 2D/3D 结果。

## 4. 不做的事情

- 不重建 MCP、TAA、KTX2/Basis、RenderGraph 或场景命令系统。
- 不把 Promise 并发写成 CPU 并行，不把 AABB proxy 写成完整 HLOD/Nanite，不把 mip0 五点 SSR 写成完整粗糙锥追踪。
- 不以关闭发布门禁、删除字段、降低分辨率或漏掉页面内容换取通过。
- 不因参考其它引擎而恢复已取消的跨引擎跑分；官方资料只用于设计校准。
