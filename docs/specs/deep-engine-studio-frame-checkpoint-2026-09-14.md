# Studio Deep 帧调度检查点

2026-09-14，本轮为 P0-08/12/13 接线增量；P0 整体仍为本轮待办。

## 23:30 环境提交失败恢复与 Windows 新候选

- 23:34 追加：正式 DeepWebGpuBackend 原先拒绝新 prefiltered-ibl 分支，已接验证与调用方快照；创建/运行时坏 payload 在 GPU 调用前拒绝。Backend/环境状态/LOD 指标 58 项通过。新增 PbrLodWork 按相机、刷新 CSM 与聚光灯累计真实 meshlet pass/dispatch/fallback，缓存视图不计重复工作；正式 Meshlet GPU 路径仍待子代理完成及根复核。
- 已完成 Browser 环境帧事务修补：此前发布候选立即销毁旧环境，随后 queue.submit 抛错无法恢复；现在保留旧环境到帧成功，未提交/零尺寸帧回滚绑定并释放候选。恢复绑定失败仍尝试清理所有候选资源；提交成功后旧资源清理失败不销毁新环境。
- 回归先红后绿，环境状态/上传 25 项通过，core/lab 类型通过。根实际 GPU 注入 queue.submit 同步异常，恢复帧与旧 HDR 最大误差 0，七帧受管资源恒定 40，最终归零；其余取消/坏包/切回/最后候选断言仍通过。提交后异步 GPU 错误不在此证据范围。
- 已生成独立 Windows `windows-portable-prefiltered-ibl-drop` candidate，代理独立解压 26/26，41 payload 文件；根读取验证报告并独立计算 ZIP SHA-256 一致：`fdf77c6c93bc1d26738dca1c4740425e90d00f9a98c7b32437ec80e929cba5c6`，4,014,365 bytes。Native 构建源指纹 `8ce74c72f0eefa7b1978d757b53eae1abb23694e4aa9a1754ac7bbfeefd0b14b`；后续改动不属于此包。
- 本轮待办：正式 Studio 流式、Meshlet 合流和真实项目/视觉/故障全项验证。P1 继续修跨包局部 geometry identity 冲突，冻结包保持不变。

## 23:22 IBL、独立聚光灯选层与同帧 chunk 复核

- 23:24 补充：显式启用本地 Naga 后，全量 323 文件 / 2689 测试通过，零跳过；治理门禁通过。独立 author frustum 真 GPU 读回确认 camera/shadow 不同实例选择、previous transform 跟随正确，资源归零。后续新增代码仍需再验。
- 已完成共享预过滤 IBL 合同、Browser 上传和候选切换。根实际 GPU 同 id/revision 环境替换变化 3100 像素；取消、坏数据、切回和最后候选生效的对照误差为 0，六帧资源 40 恒定、最终归零。协议与边界见 [IBL 合同](deep-engine-prefiltered-ibl-contract-2026-09-14.md)。
- 已完成作者 LOD 相机/CSM/每盏聚光灯独立视锥输出。根首次 spot GPU 失败揭示 352-byte frame buffer 与 shader 384-byte ABI 不匹配，已改用共享常量并补分配/上传/偏移测试；重跑四种选层 tile 阴影像素为 15138/0、0/15138、0/0、15138/15138，与显式展开几何对照误差 0。缓存帧不重算 spot，GPU 错误和诊断为空，双 renderer 资源归零。
- 已完成 core 多 chunk 单次提交消费。根首次 GPU 失败发现读回重复 getMappedRange，修为一次映射多偏移并补 API 约束回归；重跑同帧 chunk 数 [2,3]、首帧一次 submit、预取晋升零上传，退休字节 21892→0，清理回基线 72，最终 dispose 为 0。此项尚不是 Studio 空间流式完成。
- MeshletIndirectExecutor 已修 compute 异常闭合、清理失败继续释放，以及发布后旧资源退役失败误销毁新资源的问题；失败测试先红后绿。正式 Meshlet 消费仍在途。
- 本次 Deep 全量 323 文件、2646 测试通过、41 项 Naga 条件测试跳过；Node 26 项与运行时纯度通过。整命令仍退出 1：5 个 P3 文件与 Native renderer.rs 301 行触发体量门禁。Naga 显式重跑、最新整合与候选包仍待，不沿用旧全绿结论。
- 本轮待办：Studio author chunk/需求/驻留正式接线，Meshlet 组合路径，全项 P0/P1 和完整视觉验收。专项像素证据不替代 design-taste-digitaltwin 的两轮产品截图验收；不新增视觉评分。

## 22:55 目录双击修复与复验

- 已完成本次修补：选择工具条保留固定占位，无选择时 `visibility:hidden`、`aria-hidden` 与 `inert`；基础元素/模型共用单击和双击处理，第二次 click 不再取消选择，双击明确选择后聚焦。
- 根实际 Studio 两轮清空→双击立方体，行 y 均为 224、height 28，选择身份与位姿正确；安装板模型双击正确，Ctrl 添加立方体后已选 2。隐藏工具条仍占 34.8px，但不可交互且不进入辅助技术读取；控制台为空，未保存/发布。
- 公共样式修改后重新跑 Web：529 文件/2685 测试通过，另 2 文件/2 测试跳过；类型/生产构建/预算通过。根再次运行真实作者 LOD GPU 探针，四种选层全部通过，结果与下节一致。
- 视觉检查限 1280 深色两轮。依 design-taste-digitaltwin 对标 ThingJS 编辑交互/Unity 渲染，沿用 base.css；本片布局 9、令牌 9、排版 9、交互 9、动效 8、3D 8、信息 9、反馈 9、响应式与主题未验、语义 9。整套视觉验收仍未通过。
- 本轮待办继续：author 逐 level GPU 视锥裁剪由 DPR 线实施，Native 同设备目录拖放由 P1 线实施。新代码不属于下节冻结候选包；P0/P1 全项范围不变。

## 22:50 作者 LOD 合流与候选包复核

本轮待办：P0/P1 全项仍未验收。本节更新此前“作者 LOD 输入缺失”和“目录 LKG 在途”的状态；meshlet、流式和完整视觉要求不变。

- `author-selected` 合同保留真实层级、distance/hysteresis、revision 和零/单/多层选择；作者矩阵与 LOD 在投影前更新，异步首帧追平不推进第二套动画时钟。Studio 已启用，共享桥默认关闭。
- 主画面/阴影消费同一选择；metadata-only 更新不重传几何或实例。驻留要求全部真实层，共享几何只租一次；缺层、屏幕层级覆盖与稀疏/继承数组拒绝。author 全局 GPU 预算仍 fail-closed，GPU frustum/Hi-Z 和按需缺层回退未交付。
- Runtime、烘焙、预热和 Native 共用 `runtime-package-author-lod-v1.json`，packageHash `7089eba4ab7d3f5dfc8eaf49904b7367fdcd75db4d978075fa60aee14326744c`。不虚构屏幕阈值或最低层回退。根 Runtime/旧 LOD/烘焙 60 项通过；代理最后驻留/元数据 82 项含 Naga 通过。
- 根真实 GPU `authorLodIntegrationProbe.html` 使用共享 golden 的双面平面 caster 变体，对照显式展开选层的正式 renderer。initial/next/none/multi 的 HDR 最大误差 0/0/0/0.0000152587890625，阴影误差均 0；非空阴影像素 3138/3403/5254，空选择 0。后三轮几何与实例写入均 0；提交失败重试成功，诊断空，受管资源归零。这不是完整流式验收。
- Native 已接对应合同、主画面/四级阴影和选层拾取。根独立 GPU 测试 14/14，目录/恢复/作者合同 5+4+3 项通过。Windows author-lod-recovery candidate 独立解压 24/24；ZIP SHA-256 `13dd01f0c82aec5dea20988699d2a0224e17fc2dfde52f3513759b74e9a3eab2`。旧包未改。目录拖放进入下一片，后续源码不能冒充此冻结包。
- 合流后根 Web 528 文件/2675 测试通过，另 2 文件/2 测试跳过；类型、生产构建和预算通过，首屏 339.4 KiB/gzip 111.7 KiB。Deep 317 文件/2635 测试全部通过，含显式 Naga；Node 26、纯度通过。整命令退出 1：GLM P3 五个超长文件仍阻断。
- 新开完整 Studio 9999 场景自动激活 Deep，Deep→WebGL→Deep 成功，控制台空；自动保存关闭、本地副本保留，未保存/发布。单击立方体身份与位姿正确。首次无选择双击误中上方模型，已定位选择工具条插入导致行位移，修复在途。

对标 Unity/ThingJS，沿用 base.css；1280 截图可见物体与网格，双主题/窄窗/完整双轮仍未验收，沿用下节未达标评分。探针源 SHA-256 `823ef64902f7ce8b373e9cdc0177e128e099acf255f03092f7d80610551c38b5`；golden 文件 SHA-256 `0452408f0b120ed0d6bcb07e5e5225a499e0cf2b4061b264e6d3ebd11b746040`。

## 22:22 作者网格、OIT 修复与切换回归

本轮待办：P0 14 项/P1 5 项的范围不变。此次为开发工作树验证，未冻结发行构建。

- 作者网格已在正式 HDR 阶段接入，读取作者纹理、颜色、雾和淡出，深度测试但不写深度。正式 GPU 探针发现 AO 关闭时 OIT 同时读写主 HDR，导致整帧被拒绝。新增 `PbrTransparencyPass`，仅发生别名时使用独立 HDR 合成目标，AO 开启时复用原目标；补齐合成三角形统计、异常 pass.end 和清理聚合。
- 根实际运行 `lab/authorGridProbe.html`：实心覆盖 `[1,0,0]`、开放网格 `[0.5,0.5,0.5]`、雾 `[0,0,0.5]`、透明覆盖 `[0.75,0.25,0.25]` 均匹配，errors/diagnostics 为空，释放后受管资源 0。读回的是正式透明合成输出，不是已被分离的旧 HDR。AO 关闭路径额外纹理为 8 bytes/pixel。
- 根实际复跑 `pbrDeformationIntegrationProbe.html?variant=materials-effects`：skin/morph/fused 三类全部通过，提交失败重试通过，每类阴影变化 515 像素，最终受管资源 0；静态 source lease 合入后稳定资源分别为 88/89/94。此证明正式 HDR/shadow/motion/culling 与 AO/TAA/OIT 组合，不证明最终时域画质已完成。
- 新 OIT 清理/回滚与绑定测试共 21 项含 Naga 通过；根全量 Deep 312 文件/2574 测试、26 Node 策略、纯度通过。整命令仍退出 1：GLM P3 五个源文件超 300 行；本轮 renderer 已低于门槛。Web 526 文件通过、2 跳过，2667 测试通过、2 跳过；生产构建与预算通过，首屏 339.5 KiB/gzip 111.7 KiB，仍有 Node 模块外置和大 chunk 提示。
- 完整 Studio“智造综合案例验证 / 9999”：20 次连续 WebGL→Deep 往返，每次分别核对设置中的当前后端，全部成功。最后仅两个画布，作者画布 opacity 0、Deep 1；控制台 warning/error 为空。选择立方体并聚焦正常，坐标仍为 `[9.93,1,-0.423]`，自动保存关闭，未保存/发布。此为交互状态证据，未录逐帧黑帧或显存曲线，也未覆盖脚本重复执行。
- 实际截图尺寸 1280×720，DPR 1.25；作者网格与移动辅助可见、实体遮挡正常。双主题/真实窄窗/完整双轮仍待。对标 Unity 渲染与 ThingJS 编辑、沿用 base.css；暂评布局 8、令牌 9、排版 9、交互状态 8、动效 8、3D 8、信息 9、反馈 8、响应式与主题未验、语义 9，视觉验收未通过。
- 大场景读审确认三项仍缺：Three 作者 LOD 没有统一 packet 输入，meshlet executor 未进入正式 packetDraw，流式 probe 逐 chunk 分别绘制、并非多块同帧。不能以现有组件或 probe 替代 P0-10/11 完成。Native 新增 Asset Directory v1 实际 Player 入口，分离 mesh/texture、迁移/重导入及损坏目录 LKG 仍待后续证据。

源码 SHA-256：`pbrTransparencyPass.ts` 为 `b58910c7e7a328fa7bae73c431b946c126e2e8013c6c064e0a4e23eccdfaac39`；`pbrRenderer.ts` 为 `cb6b5d4376cec65ccba4f83645003b9b0a353a47ca38ebde2f3f17211ed6dcf6`；`authorGridProbe.ts` 为 `2e8724d40889cb94081b12072e41d47ec74cfd53f059b66913a6dcd23990b308`。

## 21:59 空间 AA、编辑辅助与完整 Studio 复验

本轮待办：P0/P1 全项仍未验收。使用 NVIDIA Lovelace 非回退适配器、开发工作树；以下数字不作为冻结发行版或完整项目性能承诺。

- 空间 AA 接入显示编码后的生产输出，`features.spatialAa` 默认开启；无 AA 基准显式关闭。保留 TAA 的深度拒绝。编辑辅助 pass 在 AA 后绘制，资源与主帧同 device/encoder，末端 GPU 时间戳覆盖辅助层。
- 实际 GPU 六类 AA 夹具通过，CPU/GPU 最大误差不超过 0.002792。固定斜边全图 RMSE 从 0.0364628 降到 0.0166866；透明、亮色、竖屏和纯色分别通过，纯色内部不变，受管资源和 diagnostics 归零。正式变形+材质/效果探针三类姿态也通过，postProcessPasses 严格为 Hi-Z+8，资源稳定于 89/91/97 后释放到 0；其 HDR 回读不证明最终运动拖影达标。
- 成本入口 `http://127.0.0.1:5298/lab/spatialAaCostProbe.html` 实测通过。每模式 20 pass 预热，15 组×32 pass GPU 首尾时间戳，顺序交替，所有组非零。720p 平坦/斜边 AA median 为 0.028672/0.036864 ms；1080p 为 0.067584/0.081920 ms，斜边 p95 0.096256 ms。1080p 全屏采样 copy 对照 median 0.020480 ms；AA 生产中间纹理增量 8,294,400 bytes。此为同格式 `bgra8unorm` 热缓存合成负载的每 pass 归一化成本，不含主渲染、CPU、上传或整帧调度。
- 完整 Studio“智造综合案例验证 / 9999”在实际 1280×800 看到 Deep 灯光代理、移动轴和旋转环；真实拖动 Y 从 1 到 1.137，撤销恢复为 1。自动保存保持关闭，未保存/发布。网格仍缺失，正补深度正确的作者网格路径；文字、测量和最终辅助色等价尚未覆盖。
- 实测发现基础元素聚焦按钮可用但回调只接受 `kind=model`。修复 Studio、发布浏览与独立 Viewer 三处，统一调用已有注册对象聚焦。真实点击后立方体从视野外回到居中近景，作者位置不变；相机/控件聚焦 3 文件 9 项通过。
- Deep 启用 Naga：307 文件、2538 测试通过，无跳过；Node 策略 26 项与纯度通过。完整命令仍退出 1，五处 GLM P3 文件超过 300 行：chart_ir 557、retained_ui 541、hit_index 440、deep2d_gpu_cache 320、deep2d_gpu 312。Web 合流类型通过，524 文件通过、2 文件跳过，2656 测试通过、2 跳过；全量早于基础元素聚焦小修，后续仍需重跑。
- 浏览器 viewport override 未实际改变已有 Studio 尺寸，DOM 仍为 1280×800；不计为 980px 证据。依据 `design-taste-digitaltwin` 对照 Unity 渲染、ThingJS 编辑交互，沿用 base.css 令牌；两轮/双主题/真实窄窗未完成，视觉验收未通过。暂评布局 8、令牌 9、排版 9、交互状态 8、动效 8、3D 7、信息 9、反馈 8、响应式与主题未验、语义 9；网格和未覆盖交互继续修复。
- 性能复核纠正：普通 pose revision 已只更新 palette/weights，并非每帧重传静态源。剩余重复在同源多 pose 的独立准备，以及完整 packet 重建；下一切片共享静态 source lease，动态输出/历史仍每 pose 独占。

源码 SHA-256：`spatialAaWgsl.ts` 为 `bda4da871d411da8185816a1d0259e7116c481c50539ac6972ff16984380745b`；`spatialAaCostProbe.ts` 为 `4cd9d68bcda362f5cfbe520176a4d29c1fbbf502bdee7f540d8ef807648d52b2`；`studioDeepEditorOverlay.ts` 为 `769514fafb3adfe342f2e25438efaf82d374b90e0a3dd3b5e881aff2378da116`。

22:03 补记：基础元素聚焦修复后的完整 Web 类型/生产构建通过，首屏 JavaScript 339.5 KiB（gzip 111.7 KiB），预算通过；构建仍报告 glTF/Draco Node 模块外置和大 chunk 提示，不称零警告。仓库治理门禁及 5 项测试通过。后续网格与共享源缓存还在实施，此构建不包含其最终产物。

## 21:38 回归与抗锯齿诊断补记

- 根为切线回读增加独立入口 `http://127.0.0.1:5298/lab/gpuSkinTangentProbe.html`。NVIDIA Lovelace 三个姿态全部通过，GPU 与 CPU 最大误差均为 `5.960464477539063e-8`，当前/前帧切线存在，historyValid 为 false/true/true，受管资源回到 0，diagnostics 为空。
- Studio 新增真实 ThreeProjectionBridge + DeepWebGpuBackend 接线测试，GPU runtime 使用替身；覆盖显式动画能力、morph/skin 姿态增量、作者数组不变及失败回退。四文件 45 项通过。
- Web 全量首轮 2645 通过、2 失败，原因是 XR 原型测试夹具缺少新增 DPR 所需浏览器状态。补真实 AdaptiveRenderScaleController 与 DPR，同时加入 XR 期间换显示器后恢复 1.5 像素比断言。聚焦 8 项通过，根全量复跑 522 文件、2647 测试通过、2 跳过，Web 类型检查通过。
- 轮廓锯齿已用独立几何参考复现：32×32 半平面、16 帧 Halton jitter、每像素 64×64 supersample，TAA 的 51 个轮廓部分覆盖像素全部仍为二值；边缘 RMSE 0.465346，时间覆盖均值参考为 0.028631。当前背景跳过历史、前景历史剔除背景样本后重归一化，无法积累轮廓覆盖率；原深度拒绝对防止露出区域残影仍有必要。
- 正在实施同一输出路径的空间 AA，以及同一 device/encoder 的作者编辑辅助 pass。上述全量结果是这两个在途切片之前的基线，不是新切片验收。网格、文字和深度相关辅助图形另需后续覆盖。

## 21:35 正式渲染器变形合流与 Studio 实测

本轮待办：P0/P1 整体未验收。正式 PacketBuffers/PbrRenderer 已启用显式变形能力，Studio 创建时传入作者动画投影能力；全局默认仍为 Three。

- 变形、几何和实例共同准备与发布；姿态增量、动态包围体、主通道/阴影裁剪、当前/前帧历史进入正式帧。取消、部分上传失败、提交失败重试和退休资源清理有测试。skin-only 切线沿用现有 skinner，输出按是否含切线为 32/48 字节，不添加虚拟 morph。
- 根浏览器在 NVIDIA Lovelace 非回退适配器执行 `http://127.0.0.1:5298/lab/pbrDeformationIntegrationProbe.html?variant=materials-effects`，skin、morph、morph-skin 均通过，收紧断言后再次通过。128 实例、五帧中 OIT 开启，Hi-Z 8 层，后处理严格为 15 次（Hi-Z 8 + AO 4 + TAA 1 + OIT 2）；第三帧起实际使用 Hi-Z 批次。
- 三类移动姿态的 motion X 均为 -0.2135009765625（预期 -0.2135569008664527），阴影深度变化 515 像素；静止姿态与静态对象位置保持稳定。受管资源在历史准备后分别稳定于 88/90/96，dispose 后均为 0；GPU error scopes 与 diagnostics 为空。此为受管资源计数，不是驱动显存证明。
- 探针数值回读的是 TAA 前 HDR、motion 和阴影，不证明最终 TAA 抗锯齿/拖影达标；常量纹理不证明每槽独立贡献或 UV1 隔离，透明物体尚未覆盖运动和重叠顺序。结果 JSON 明列这些未覆盖项。
- 完整 Studio 的“智造综合案例验证 / 9999”在 1280×800、980×800 实测 Deep 激活和 WebGL 回切，控制台未记录 warning/error。保留本地恢复副本，自动保存关闭，未保存或发布。1280 下 Deep canvas 为 728×748，与 CSS 尺寸一致。Deep 斜边仍有锯齿，网格和灯光辅助图形缺失；回切后辅助图形恢复，视觉验收未通过。仅一次往返，不计为三项目/20 次切换验收。
- 根复跑 Deep：300 文件、2457 测试通过、39 跳过；Node 策略 26 项与 runtime purity 通过。整个命令退出 1：source-size 六处超限，其中五处属于 GLM P3，另有 Native `shadow_probe.rs` 304 行交其负责人修复。未把跳过的 shader 测试或临时放行 lint 计为严格门禁通过。

本次源码身份（SHA-256，开发服务器工作树，不是冻结发行构建；路径相对 `packages/deep-engine`）：

| 文件 | SHA-256 |
|---|---|
| `src/webgpu/pbrRenderer.ts` | `d9e63d5d7b0bfbece17d08853b675ce1250e2fd33d41fb471dd774444910a429` |
| `src/webgpu/packetDeformationState.ts` | `adea74d003ca11d263ad6fd908fc2231ad1b5951491b41fa37060e0a6a7d3afa` |
| `src/webgpu/gpuSkinningWgsl.ts` | `50b6bca696afa3e1473d5c9946b05b9252855ca0565c1fb858f6e037aaaab46c` |
| `lab/pbrDeformationIntegrationProbeFixture.ts` | `df086376d7e71f69244f3654b61007865e700e87774ee7afec57bf70791cbec5` |
| `lab/pbrDeformationIntegrationProbeMaterials.ts` | `ceaf4acaf6d4aac22f23e4b5c0579a8337e243dfb62f94e4fc10ee7e7e684d3c` |

下一步：修复轮廓抗锯齿及作者辅助层，继续动画真实资产、LOD/Meshlet/驻留合流、三项目/20 次切换和 Native/资产包完整门禁；这些项目不因固定探针通过而删除。

## 21:04 动画候选资源事务

- Packet staging 新增显式 executor opt-in，变形资源与纹理、几何、实例进入同一候选。分配或后续几何上传失败、候选取消时一起释放；复用旧几何时不释放借用资源。
- 7 项新测试覆盖三类变形、默认拒绝、部分失败、借用隔离和清理失败继续回收；三文件合计 59 项通过，Deep core/lab 类型通过。正式 PacketBuffers/PbrRenderer 尚未启用此入口，不能视作 Studio 动画完成。
- 20:58 根新增四个数学反例均复现旧 bounds 低估；修复由 bounds 代理进行。下节 18:43 的保守性结论撤回，以新反例及后续验证为准。

## 18:43 动态包围体修正尝试（保守性结论已撤回）

- `deformationBoundsEnvelope` 改为考虑包围体中心偏移、每个骨骼线性变换最大尺度、平移和 preserve 权重总和，覆盖非单位尺度/剪切的保守上界；原有 3 项 envelope 测试与类型检查通过。仍未用真实动画顶点逐帧验证，也未接正式 renderer。

## 18:41 动态裁剪缓存回归修复

- 新测试实际复现：同一 geometry revision 和 batch 引用下，动态半径 3→4 没有重新上传。修复为缓存已上传的四元边界数值，中心/半径变化触发更新；相同值跨主/阴影通道复用，移除动态输入恢复静态边界。
- 非有限值、float32 溢出及非正半径在上传前拒绝，并清除旧可见性结果；合法输入恢复可重试。根三个专项文件 20 项通过、源码类型检查通过。此为 GPU 输入调用的单元验证，不是 GPU 像素或 Studio 动画验收。
- 前述动态 envelope 数学仍须覆盖偏心几何、剪切、原始权重和 morph→skin 组合，尚不能据简单平移用例认定任意姿态都被包住；正式 renderer/作者桥接入继续待办。

## 18:12 门禁复跑与文件体量

- Deep Engine 全量 293 个测试文件、2387 项通过，39 项按环境跳过；runtime purity 通过。source-size 仅剩 GLM P3 `deep2d_gpu_cache.rs` 318 行；此前 `packetBuffers.ts` 因动态 culling 接线达到 302 行，已在不改变职责的前提下整理回 300 行。P0/P1 尚未完成。

## 18:09 动态包围体接入 culling

- `PacketCullingResources.encode` 与 `PacketBuffers.encodeCulling` 现在接受可选的每批 `DeformationBoundsEnvelope`；GPU culling 写入动态中心/半径，未提供时保持静态路径。Deep Engine 类型检查与 culling/packet/deformation 相关 12 项测试通过。正式 renderer 尚未构建动态 envelope map，Studio 真实动画裁剪仍待接线。

## 17:51 动态包围体准备

- 新增 `webgpu/deformationBounds.ts`：根据 morph 权重位移、skin 姿态骨骼平移/尺度计算保守 envelope，保留中心并扩张半径；非法输入在发布前拒绝。13 项测试与引擎类型检查通过。尚未接入 PacketBuffers 的正式 culling map，不能宣称动画裁剪已完成。

## 17:47 抗锯齿与动态批次接线

- WebGL FXAA 移至 OutputPass 之后；Three WebGPU SMAA 移至显示转换之前，FXAA 保持 sRGB 输入。核对当前本地 Three 实现要求；根执行四文件 17 项测试通过。未改变用户场景参数。截图两轮和切换后的真实画质比较仍未完成，锯齿缺陷保留。
- 原 Studio 模块解析失败已恢复，独立测试页实际打开完整工作台和服务器场景；选择“稍后处理”，保留未保存副本，没有保存或发布。浏览器会话随后重置，当前没有可复用测试页。
- 正式 PacketDeformationResources → DeformationDrawBindings 探针实际通过三类变形、共享 source 双 pose 隔离、取消后重编码；NVIDIA Lovelace，主画面与阴影各 130 像素，motion 0 → -0.399902 → 0，诊断为空、受管资源归零。之后新增静止提交姿态跳过 compute，根 82 项合同/资源测试通过；这次优化后的新 GPU 探针尚未读到结果，不沿用旧结果证明新版本。
- packetDraw 已接入显式动态绘制上下文，使用 pose 绑定和独立动态可见性输入，不消费静态包围体的裁剪结果；静态切线不混入变形顶点流。缺失、过期、错误身份/布局、display 和未映射 LOD 明确拒绝。根三文件 25 项测试及引擎类型检查通过。
- 三路代理因额度/登录失效停止，主线接管落盘代码。PacketBuffers/PbrRenderer 的事务、动态包围体、作者桥、LOD/Meshlet/流式仍待接通；P0/P1 未完成。

## 17:27 GPU 动画计算与资源事务

- 根浏览器实际执行skin、morph、morph→skin三类compute→48-byte提交历史→正式plain/unlit HDR、作者solid shadow、motion。每类baseline/moved/settled主影覆盖均130像素，中心从18.7923移至44.2077，motion为0→-0.399902→0（预期-0.4）。history首帧无效、移动更新、稳定复用均实测；NVIDIA Lovelace非fallback，diagnostics空、释放后受管资源0。尚不包含纹理/normal-map像素矩阵或Studio真实模型。
- 独立GpuDeformationHistory真实GPU五项读回误差均0，覆盖32→48、第二提交历史保留、取消未提交后重试、同pose复用和48-byte源重置；此探针的输入是固定GPUbuffer，只验证history。
- PacketDeformationResources首片已复用三类compute与历史，按pose管理候选、更新、编码、commit/cancel；部分上传失败阻止半帧编码，并显式标记旧输出stale。静态GPU输入暂每pose独占，共享静态输入仍需合流。
- DeformationPoseValidator在prepare缓存静态界限，热帧仅O(joints+targets)检查动态数据；DeformationDrawBindings借用材质与当前/上一姿态，缓存双缓冲组合并清理退役身份。三类compute统一修复准备回滚、发布后旧资源退役失败、dispose/device loss和pass结束异常路径。
- RenderPacket变形合同正在合流；静态staging、instance update和resident projection已显式拒绝尚未接通的deformation/pose，防止静默绘成静态。主线99项相关测试（含Naga）、核心/lab类型通过；资源wrapper整体绘制探针正在补充。
- 本轮待办：正式PacketBuffers/PbrRenderer消费者、作者bridge解除拒绝、动态bounds、LOD/Meshlet/流式合流、真实资产与往返视觉验收。上述固定GPU证据不缩减P0-05范围。

## 17:15 GPU 动画消费者首片

17:17 真GPU补记：根浏览器运行pbrDeformationPipelineProbe，NVIDIA Lovelace非fallback实际创建18主通道+18普通/作者阴影管线全部成功，48-byte双姿态bindings11/12成功，缺少motion buffers路径明确拒绝，diagnostics空且释放后受管资源0。复现：`pnpm --filter @bim-studio/deep-engine exec node scripts/pbrDeformationPipelineServer.mjs` 后打开输出URL。此记录仅证明驱动创建/绑定，不含实际draw或像素、shadow/motion读回。

- 新增 DeformationSource/Pose/Snapshot 严格合同及拥有快照；新增绝对/相对 morph 作者适配与显式顶点 remap，权重独立捕获，不推进作者时间线。单位法线、支持语义和数值边界仍明确校验，不自动假定任意Three对象可用。
- PBR 新增48-byte当前/上一姿态storage读取入口，保留静态UV和实例布局。主通道、normal-map、solid/MASK阴影共四个顶点入口；motion同时使用上一姿态与上一实例矩阵。
- createPipelines支持显式deformation候选，18种主通道与18种含作者阴影变体复用既有材质/光照fragment。group1增加bindings11/12，不增加vertex attribute；暂不支持绕过geometry buffers的direct-display路径，避免丢失motion历史。
- 根复跑合同、作者skin/morph、pipeline与新shader共60项通过，核心及lab类型通过；独立shader加既有PBR测试23项含Naga通过。真实GPU管线创建验证、提交历史与资源故障修复正在推进。
- 尚未扩展RenderPacket消费者和解除Studio拒绝；动态bounds、LOD/Meshlet、主画面/阴影/motion实机与作者状态往返仍为本轮待办。以上不是P0-05完成结论。

## 17:04 作者 Bloom 合流与锯齿复查

17:09 全量复验：根显式启用Naga后运行Deep `vitest run src lab`，280文件2272项全部通过。`authorSkinPose` 已生成独立拥有的当前骨骼palette，使用Three线性normal规则、不读取过时boneMatrices、不调用作者更新；共享skeleton不同bind与快照隔离由真实Three测试覆盖。该首片未接消费者，不能视为Studio GPU动画已经可用。

17:08 验证补记：根通过浏览器实际运行独立 Author Bloom GPU probe，NVIDIA Lovelace 非 fallback，六项固定 HDR 输入全部零超差，容差 `0.003 + 0.004 × |reference|`；最大相对误差 0.3653%（热参数），最大绝对误差 0.25（1px 高亮 HDR）。diagnostics 为空，释放后受管资源数为零。清理失败已聚合，旧资源退役异常不会误释放新 cache；相关29项含Naga及lab类型通过。可复现命令 `pnpm --filter @bim-studio/deep-engine exec node scripts/authorBloomGpuServer.mjs`，打开输出URL；此次临时服务已停止。固定探针通过不代替Studio两轮视觉验收。

动画首片新增 `SkinningSource.weightMode`：默认归一化保持不变，`preserve` 保留作者非零非负权重，fused morph-skin共用同一打包器；零总权重仍明确拒绝。默认/显式模式、拥有快照、融合输入与非法参数测试通过，连同既有skin/morph-skin共16项（启用Naga）及核心类型通过。尚未解开Studio骨骼/morph拒绝，消费者与姿态历史仍待接入。Web生产构建已通过，首屏339.5KiB/gzip111.7KiB。

- 作者 Bloom 新增独立执行路径，保留旧 Bloom 默认算法；读取原始 strength/threshold，不做经验换算。按本地 Three 0.185.1 实现五级 Gaussian、半尺寸合成再叠加原图，固定入口避免同帧 uniform 覆盖。
- 核心相关 74 项含 Naga、类型、构建和纯度通过；主线独立复跑 Studio 参数与桥测试 30 项通过。真实 GPU 像素比较正在补充，不能据此标记作者 Bloom 画质已验收。
- 用户反馈锯齿后复查：正式 Deep 默认 TAA 开启、主通道单采样、静止补 16 帧；没有发现全局关闭 TAA。当前观察到的 WebGL 画布为 525×800，CSS 420×639.6，诊断显示像素比 1.25、100% 画质。网格固定纹理仍缺屏幕频率淡出，模型轮廓、阴影和网格须分别复核。
- 当前 Studio 标签保留过一次模块未落盘造成的动态导入失败；模块请求现已返回 HTTP 200，但该标签再次切换仍失败，WebGL 未中断。该次是开发态失败保留证据，不是成功切换或视觉通过证据。
- 动画下一切片复用作者唯一时间轴与现有 GPU deformers；隐藏 WebGL 不再更新 skeleton 缓存，palette 必须从最新 bones.matrixWorld 与 boneInverses 获取。GPU 输出接主通道/阴影、动态 bounds、motion 和设备恢复仍为本轮待办。

## 16:47 作者后处理与 Native 材质消费者

16:52 合流补记：根复跑 Deep 全套时显式启用 Naga，274 文件、2213 项全部通过；此前未设环境导致的 36 项跳过不再作为最新证据。输出阶段已归并 legacy/author uniform、绑定、呈现与资源释放职责，PbrRenderer 回到 300 行；后补输出生命周期专项 36 项通过。时钟由既有渲染边界注入，未放宽 runtime purity allowlist；双类型、构建及 purity 最终通过，体量门禁仅余既有 P3 cache318行。实机验证在此次职责抽取前完成，抽取后的完整图像复验仍待做。

- 正式 Studio 双 RenderView 入口现在每帧传作者暗角、色相/饱和度/亮度/对比度快照。独立 32-byte 输出 uniform 保持旧 frame ABI；顺序按本地 Three r185：Vignette→HueSaturation→项目 BrightnessContrast→曝光/ACES→sRGB。非空效果禁止 direct 快路，显式空对象关闭 Deep 预览暗角；legacy HDR grade 不与作者 grade 混用。
- AO/Bloom 执行开关来自实际 Composer 和作者状态，关掉时跳过对应 encode。未分配能力被要求启用时拒绝；AO 改变时重置时域历史。开关已接线，算法尚未等价：Three Bloom 的亮度阈值、5 级 Gaussian 与权重合成不同于 Deep soft-knee/5-tap，GTAO/SSAO 强度参数也仍待接入。
- Web 全量 517 文件 2632 项通过、2 文件/2 项跳过，类型与生产构建通过，首屏 339.5 KiB/gzip 111.7 KiB。核心颜色效果 53 项含 Naga，后补 tuple/生命周期 31 项通过；逐帧开关 24 项和双类型通过。完整 Deep 测试门禁结果另记。
- 实际 Studio 成功激活 Deep，开启原先关闭的暗角/调色，色相 0→90、亮度 0→0.2 后背景和模型产生实际变化；随后数值归零、关闭两效果，画面恢复。两轮窄窗截图可见，UI 不受调色影响。未保存/发布；取景与测试撤销历史保留。浏览器仍有 Three/ANGLE 双精度编译 warning，无本轮 WebGPU shader 错误。
- Native 严格读取 castShadow/receiveShadow/shadingModel 并接入批次键、指纹、culling/LOD/阴影绘制及两层 dirty；bit16/64 与 Browser 相同。46 项 CPU、RTX 4060/Vulkan 3 项 GPU 通过：receive 变化影响 5453 像素但四级深度不变，cast=false 清空四级深度且主画面保留，Unlit 输出符合线性 base-color golden。完整 Cargo 仍被 P3 的 queue 参数和 Option<Arc> 两错阻断；测试通过不代表原生包可交付。
- 本轮待办：完整视觉十维门禁、多尺寸与运动/透明边缘；Bloom/AO 算法与参数、辅助层、透明接影地面、动画/顶点色、跨后端材质 fog、三项目/20 次切换/资源故障矩阵。未将这些转为项目级后验收。

## 16:27 隐藏绘制、真实性能源与 Unlit 主路径

16:34 实机补记：移除 Unlit 非一致 early-return 并重新构建后，真实 Studio 已成功激活 Deep，下方“正在重验”状态已被本条更新。安装板近景分别在 Deep 与 WebGL 截图检查斜边和孔洞；仅覆盖 530×698 内嵌窗口，模型右侧裁切，宽窗、运动和透明边缘仍待验证，不计完整画质通过。

Deep 面板首次持续等待样本，操作后出现 62 个样本、4 draw calls、约 1K 三角面、纹理数不可用、GPU P95 0.3ms。帧间隔 P95 923.5ms 与 GPU 耗时差异很大；后台调度是待核查因素，不能用此组数字宣称引擎性能结果。新增递增 RAF 的 Bridge→采样器→16 帧收敛测试，相关 54 项及 Web 类型检查通过；根复测抗锯齿/采样/收敛 3 文件 38 项通过。

已恢复 WebGL、隔离前可见性并清除选择，没有保存或发布。测试改变了取景并产生隔离/恢复操作历史，原草稿和历史保留。Native 审查确认四个新增字段仍被严格拒绝；不能只放宽 schema，必须同步批次/缓存/阴影和材质消费者。原生材质雾还需改变全屏深度雾的消费方式。

- Deep 订阅活跃时跳过隐藏作者 WebGL/Composer 的全场景绘制，保留作者动画、导航、物理、矩阵更新和订阅通知；XR、offscreen、无订阅及回退继续原绘制。切换唤醒首帧，阴影配置主动更新相机投影，不再依赖 WebGL 首次分配补做。
- 性能面板、导出与自动质量读取实际 Deep 提交数据。FPS 按显示帧合并同 RAF 多次提交，静止收敛后断采，后台断采；GPU 分位数来自 Deep timestamp，未知纹理/几何分项不借用 WebGL。资源数、实际阴影尺寸、CPU/GPU 阶段保留在 Deep 证据中。
- MeshBasic 已映射到同一 RenderPacket 的 Unlit 模式，bit64 保留基础色、纹理、透明度、双面与雾；屏幕 AO 通过 normal.a 标识跳过 Unlit，不改深度/运动语义。顶点色、Basic lightMap/aoMap/specularMap 等仍待支持，Native 尚未同步新合同。
- 验证：Web 全量 516 文件、2623 项通过，2 文件/2 项跳过；同 RAF 去重修正后的 6 文件 73 项通过。Deep 全量 Vitest 271 文件、2169 项及 26 个 Node 策略通过，Naga 启用。运行时纯净性失败的 DOMException 已修复并复测通过；Deep/Web 构建与类型检查通过。完整体量门禁仍被既有 P3 Rust 318 行、App 810 行与 useAppRuntimeEffects 832 行拦截。
- 实机首次尝试抓到 Dawn uniform-control-flow 校验错误（Unlit early-return 后执行 fwidth），候选拒绝且 WebGL 保留；已移除非一致 early-return 并构建，正在重验。当前 Unlit 通过共同出口选择颜色，仍执行共享 PBR 算术，不把此实现记为已优化 Unlit 计算成本。

## 16:08 阴影热换、透明投影与作者雾

- 作者 BLEND 对象在主方向阴影中按 Three 的 alphaTest=0 语义写深度，opacity=0 也不误裁切；通用包原有透明阴影行为不变。大批透明实例目前走直接绘制回退；透明+alphaTest 组合仍待支持。
- 阴影分辨率后台分配与 GPU 验证，匹配新尺寸的可绘制帧才发布；旧资源等 GPU 提交完成后退休。取消、覆盖、销毁立即释放在途候选；迟到结果和发布回调重入不覆盖当前资源。Studio 以实际帧 metrics 确认新尺寸，未提交候选被新编辑替换时仍使用旧尺寸。
- 全局阴影关闭时预留作者真实尺寸。独立审查修复零尺寸帧提前发布阴影造成两侧状态不同步；Studio 控制器按画布样式、环境会话、阴影会话拆分职责。
- 作者 Fog/FogExp2 的颜色与距离/密度已进入 HDR 着色器，使用相机深度而非径向距离；显式无雾会关闭旧预览雾。作者雾禁用不支持的 direct 快路；无 Composer 的显示域雾仍待实现，材质 fog=false 正在补充。
- 验证：Web 全量 514 文件、2603 项通过，2 文件/2 项跳过；后续独立会话补测另 3 项通过。Web 类型与生产构建通过；Deep 构建/双类型通过。Fog 68 项含 Naga，再增零尺寸顺序 1 项；阴影热换主切片 62 项，生命周期补测与环境合计 23 项通过。
- 真 Studio“9999”保留阴影启用 Deep，切雾天后画布仍可见；随后已恢复晴天，未保存或发布。实际模型截屏可见，尚无多距离/透明物体/分辨率热换的完整像素矩阵，不计为完整视觉通过。控制台出现 1 条 Three/ANGLE 双精度编译 warning（非 WebGPU 错误），留待同族诊断。
- 16:10 补记：材质 fog=false 已经 Three→packet→bit32→主着色链接入；非 shader 184 项与 shader 25 项含 Naga 通过，默认包行为不变。MeshBasic/独立 DeepSL Unlit 仍不在当前作者桥主路径，Native 严格拒绝新增 fog 字段，均未标记跨后端完成。
- 本轮待办：隐藏 WebGL 重复绘制及真实后端独立性能计数、透明接影地面、辅助层、材质雾开关实机像素、作者后处理、Unlit 作者桥、非 Composer 显示域合成、多项目与宽窗视觉。

## 15:49 作者方向光阴影接线（像素验收待做）

- 从 Three 正交阴影相机生成 WebGPU 深度矩阵，保留作者分辨率、signed bias、world normalBias、强度和 PCF 半径；不修改作者阴影缓存。唯一投影方向光进入主光槽，多投影方向光及不支持的过滤明确报告。
- Studio 创建时请求单层 exactProfile，后端核对 GPU 实际尺寸、层数与字节数。对象 castShadow/receiveShadow 分别进入阴影绘制和接收门控；普通、间接和 LOD 绘制共用跳过逻辑。旧 Native 尚不接受新增关闭标记。
- Web 抗锯齿、时域收敛、阴影矩阵及三组宿主桥回归：7 文件 105 项通过；Web 类型检查通过。核心作者阴影 61 项含 Naga、Deep 双类型与构建通过；对象与资源邻居 251 项通过、1 GPU 项跳过。
- 独立审查发现作者 PCF caster 正反面剔除与 Three 默认相反，已修作者专用管线并重新通过 61 项与构建；普通/局部管线不变，另有阴影家族 44 项通过。
- 15:51 实际 Studio 在作者阴影开启状态成功启用 Deep，控制台无 warning/error；两画布都是 525×800、CSS 420×639.6。连续 Deep→WebGL 对照中模型位置一致；更早截图跨了适配相机与热更新，不作为位置缺陷证据。仍无阴影落在接收表面的充分截图，不能据此宣称阴影或抗锯齿像素验收通过。性能面板仍混用 WebGL 采样数据，后端独立统计待接。
- 本检查点的尺寸重配缺口已在 16:08 切片实现，像素热换验收仍待做。透明接影地面、辅助层和作者后处理仍待接入。

## 15:35 作者天空与 IBL 实际接线

生产构建补记：Web build 退出 0，含类型检查、Vite 与包预算；首屏 19 chunks、339.4 KiB/gzip 111.7 KiB。既有 glTF/Draco 的 fs/path 浏览器外置与大 chunk 警告仍存在，不记为零构建警告。

- Studio 创建 Deep 时转换当前已加载环境/背景纹理，不重拉 URL；同一纹理复用转换，独立背景保留独立 RGB，禁用反射时用零 IBL。传入真实环境强度与 Three ACES，关闭内置实心地面和预览网格。
- HDR 原始全景图随环境资源发布/回收；背景按实际相机方向及作者逆旋转采样，不写深度，在透明/后处理之前进入 HDR。背景强度与 IBL 强度分离。
- 使用实际 Composer 是否生效判断天空色调映射；无 Composer 的纯色/sRGB 背景显示域合成、模糊天空及 IBL 旋转仍未接入，明确报告限制，不用预览图替代。
- 活跃环境更换在后台转换/预滤，旧画面继续绘制；B→C 和 A→B→A 取消旧请求，迟到结果不替换当前天空；销毁、超时、GPU 失败与参数中途变坏均有测试。
- 验证：Web 全量 510 文件、2567 项通过，2 文件/2 项跳过；作者源、view、三组桥接聚焦 85 项通过。背景核心 35 项含 Naga、桥接及环境资源 47 项通过；Deep 双类型及构建通过。生产 Web 构建结果另记。
- 真实 Studio“9999”在暂时关闭阴影后成功启用 Deep；工业摄影棚→明亮展厅→工业摄影棚动态换天空成功，Deep 画布仍可见（525×800 实际像素），控制台无 warning/error。原天空和阴影已恢复，未保存或发布；恢复阴影触发已知参数差异的受控 WebGL 回退。
- 窄窗两次画面已确认内置灰地面和天空偏亮替代被移除；尚无宽窗、透明背景混合及完整十维视觉证据，不宣称画质验收完成。作者阴影强度/偏移/投影/过滤、透明接影地面、辅助网格/选择层及其余后处理参数仍是本轮待办。

## 15:08 抗锯齿复核与实际后端

- 抗锯齿、有限时域收敛与桥接聚焦 3 文件 52 项通过；Web 类型检查通过。核心 castShadow 切片另有 64 项、Naga 与双类型检查通过。
- 实际 Studio 场景“9999”在 530×698 窗口中重新取景并截图；渲染设置显示 WebGL 2、DPR 1.25、标准画质 100%，未启用动态降分辨率，控制台无警告或错误。
- 当前场景的 Deep 切换被作者方向光阴影参数与 HemisphereLight 诊断阻断，保留 WebGL 画面。该截图不计为 Deep 画质验收。灯光投影现已接入桥接，并按相机图层过滤；完整环境与后处理配置仍待接入。
- 对标 Unity 的边缘稳定性，使用既有界面令牌；本次仅复核窄窗模型斜边和网格。十维验收中布局、令牌、排版、交互、动效、渲染、信息、反馈、响应式/主题、语义均未形成完整双轮证据，暂不评分或宣称视觉验收通过。宽窗、运动边缘、透明轮廓与 Deep 实际画面继续待验。

## 已完成的局部修复

### 15:14 接线与取消增量

15:18 合流复核：核心 ambient/hemisphere 80 项、Naga、双类型和构建通过；独立 64-byte binding 保持 Frame ABI，相同系数不重复上传。实际“9999”临时关全局阴影后 Deep 成功激活，无控制台 warning/error；恢复原阴影后受控回退 WebGL。未保存或发布。两张 Deep 窄窗画面显示地面、天空及整体亮度仍不同于作者，不视为视觉验收通过。状态清理追加重入销毁与异常继续清理两项，PbrEnvironmentState 10 项、连漫反射与 binding 33 项通过。

- Web 全量 507 文件、2509 项通过，2 文件/2 项跳过；随后灯光与桥接 3 文件 53 项通过。新桥接测试使用真实 Three 场景和真实投影，但 GPU 后端为替身，不能作为像素证据。
- 作者全局 shadowMap 开关参与 Deep 投影；关闭全局阴影时不误报灯上的 castShadow。新增 ambient/hemisphere 投影读取线性天空/地面色和归一化世界位置，核心 GPU 接线正在合流，暂未记为画面通过。
- PbrEnvironmentState 保持取消直到下一次帧边界发布；已取消请求不启动 factory、不取代已有待发布候选；发布/替换/销毁移除取消监听。8 项状态测试通过。
- Native package_open 单次测试仍在编译阶段被 GLM P3 两处错误阻断，未执行测试。Windows 便携包 README 已补自有包带引号路径、普通窗口拖放、失败保留旧场景及模式限制；PowerShell AST 与 here-string 求值通过，未构建便携包。

- Deep 通过 `subscribePresentationFrames` 跟随 `viewerEngineRuntime.ts` 的作者更新与 renderDemand，不再创建独立持续 RAF；动画、物理、相机和输入保持原作者循环。
- 后端同步未完成时，作者通知合并为一次尾随同步。异步验证完成后补绘最后结果，不反向唤醒无限投影循环。
- 取消、回退及销毁解除订阅；旧后端的同步结果、异常和 finally 不修改新后端状态。
- 资源回收读取实际作者 renderer 后端，不以 Deep 展示状态触发 Three WebGPU 的整机重建。
- 候选准备具有 30 秒总超时；取消即时移除候选画布，迟到 GPU 后端释放后不发布。静止设备丢失直接触发回退，不等待作者帧。
- 显式空方向灯列表关闭默认主光；省略列表保留既有预览默认语义。

## 验证

当前工作树未提交，基线 HEAD 为 `cd9850b`，不能仅凭该提交复现当前代码。

```powershell
pnpm --filter @bim-studio/web typecheck
pnpm --filter @bim-studio/web test -- src/viewer/StudioDeepWebGpuBridge.test.ts src/viewer/viewerRenderDemand.test.ts src/viewer/rendererBackendPreference.test.ts src/viewer/webGpuRendererLifecyclePolicy.test.ts
git diff --check -- apps/web/src/viewer apps/web/src/hooks/useAppRuntimeEffects.ts apps/web/src/controllers/scenePersistenceController.ts
```

初始调度聚焦为 4 文件、30 项通过。加入候选准备与 idle device loss 后，五文件（额外 `prepareStudioRendererCandidate.test.ts`）54 项通过，其中桥 15、准备 helper 21；Web 类型检查通过。灯光核心聚焦 6 项通过。测试使用可控作者帧通知、延迟 Promise 和假画布，证明调度与取消行为，不证明真实 GPU 性能或画质。

Deep 全量 249 文件、1851 通过/34 跳过；26 脚本测试及 runtime purity 通过。该次命令总退出码为 1：后续 source-size 被 `player_diagnostics.rs` 的 306 行阻断。后续按内容身份职责提取 `player_diagnostics/content_identity.rs`，诊断 2 项测试、fmt 和全目标 Clippy 通过，source-size 复跑 1067 文件零警告/失败；未将原失败命令改记为成功。

Web 全量一次结果为 501 文件通过、1 文件失败、2 文件跳过，2414 项通过、1 项失败、2 项跳过。唯一失败为旧 `rendererCapabilities` 说明断言；已同步真实 Deep 接线说明和“仅显式选择、默认仍 WebGL”的断言，相关 12 项复测通过。修复后全量仍需重跑，不能以聚焦结果替代。

环境线新增 `studioDeepEnvironment.ts` 和 lights 适配，直接读取作者线性颜色、世界灯光及曝光；返回无法等价映射的环境/后处理问题。此适配尚未接入 bridge，不能把接口存在当作产品灯光已对齐。

## 本轮待办

1. 隐藏 WebGL 在活动帧仍绘制；替换 world draw 前须接好测量、选择、transform gizmo、剖切、标注等辅助层。
2. 活动作者帧仍执行完整投影和 Box3 扫描；需区分资源、变换、相机和环境修订，接入已有增量合同。
3. 候选首帧仍需在后台准备后追平最新 revision；本轮尾随同步不代替原子发布验收。
4. 静止 device loss 的主动通知已通过宿主测试，真实 GPU 仍待核验；环境/灯光/质量档与诊断接线尚待完成。
5. 真实三项目、20 次往返、GPU/内存回落、两轮视觉及全量构建门禁未由本轮聚焦测试覆盖。

后续继续遵循总规划，不以本检查点替代 Deep WebGPU Beta 可交付结果。

## 14:18 后续验证

- Web 全量复跑：502 文件通过、2 文件跳过；2415 项通过、2 项跳过，退出码 0。随后回切取消新增一项，桥 16 项通过，环境+桥 25 项通过；这些后续增量尚未另跑全量。
- WebGL 回切等待帧边界时的取消已改为可中断；后台不派发 RAF 也立即结束，不残留候选等待。
- 对照本地 Three 0.185.1 shader 修复局部光：距离衰减分母下限统一为 0.01，聚光半影统一三次 smoothstep；CPU 与 WGSL 同步。保留既有 range 归一化 epsilon，不扩大变更。
- 灯光线 31 项（启用本机 Naga，包含组合 WGSL 验证）、Deep src/lab 类型检查通过。主线独立复跑局部衰减与 clustered PBR 为 27 通过/2 shader 跳过，未把两种运行环境计数混用。真实 GPU 像素与 Native 局部光对齐仍待验收。
- 环境适配移除上述两个已修数值差异，阴影、环境、雾与后处理差异继续保留。Native 当前主 shader 仍为单方向光，未在本批添加点/聚光。
- 完整 Studio 启动器确认健康：Web 5173、API 4100、电池 Rust ONNX、视频、云渲染 Worker 正常；未启动独立 Lab。
## 14:43 作者环境合同与原生打开续接

- Deep 增加独立 `groundPlane` 配置，默认保持现有预览地面；关闭时不绘制、不计入 draw/triangle，也不逐帧打包或上传地面实例。`groundGrid` 仍只控制网格装饰。地面/特性/环境强度/相机四文件28项、Backend/Post邻居22项、Deep src/lab类型和build通过；尚未接入Studio透明ShadowMaterial接收面。
- 环境只读审查确认：Studio保留原始HDR/EXR DataTexture或CanvasTexture，不需PMREM逆转换；现桥未传renderer配置，且后处理/HDR创建后变更没有版本化候选重配置。下一步复用原始像素转换和现有HDR预滤波，曝光/灯光/强度从唯一作者状态读取。
- Native普通Viewer已接入拖放、单后台IO worker、单槽请求合并和错误保留当前场景；GPU候选准备仍同步。新增四项测试尚被并行P3编译错误阻断，不能计为通过。原生线继续审查候选异步化与发布一致性。
- 完整Studio已在浏览器实际打开项目工作台，并从“9999”预览按钮打开真实场景，可见立方体和地面；这只证明现有场景入口可用，不是Deep画质/切换验收。旧失效标签无法读取，未依赖其错误页判断新服务状态。
- Web最新类型检查遇到正在开发的环境纹理转换模块三项类型错，已交还该文件工程线修复；上一轮70项与类型通过记录仍仅对应此前快照。本批未过两轮视觉验收。
## 14:55 锯齿反馈修复

- 当前测试场景实际为Deep Beta，物理像素比1.25匹配设备，未见降分辨率。最近邻历史采样在jitter 0.49→0.50处的跳变已数值复现并改为逐tap深度校验的双线性；51项含Naga和Deep双类型检查通过。
- Studio已提交快照补16帧收敛，先延迟1帧；持续作者通知重置等待，避免活动时额外叠加绘制。有限补帧不调用作者脚本、资源sync或Box3；隐藏暂停、旧回调隔离、退出撤销。桥与调度45项、Web类型检查通过。
- Three HDR composer启用颜色/深度共同支持的最多4×MSAA，避免进入后处理丢失canvas抗锯齿；与动态分辨率和既有WebGPU后处理计划16项通过。浏览器已复核工作台、真实场景与修复后画面，日志无warn/error；工具仍返回530×698视口，申请1280覆盖未实际生效，已reset，不能计为1280验收。
- 视觉状态：小视口立方体可见，仍需标准桌面尺寸、斜线/细杆/透明边缘和运动对比，不做整体画质达标结论。重载出现本地恢复提示时选择“稍后处理”，服务器场景与本地恢复副本均保留，未保存或发布场景。
