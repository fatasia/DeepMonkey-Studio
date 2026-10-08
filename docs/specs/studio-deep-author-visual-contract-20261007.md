# Studio Deep 作者视觉合同核查

## 变形场景作者填充光现状核查

源码与未跟踪文件已检索 global-illumination / hemisphere / deformation；已读 RenderPacket.deformation、RenderView.lights.hemisphere 与现有 Three 半球光合同。依赖仍为现有 Three/Vitest，无新增库。消费路径为 StudioDeepRenderView → projectStudioDeepLights → 已有 authored diffuse 打包；读过站位光排除、手势缓存、GI 可用性守卫测试及本规格、引擎切换规格与交接。

已有（不重建）：作者半球光颜色、强度、世界方向、隐藏与图层过滤，以及探针可用场景排除站位光、防止双重计账的合同。

真实缺口：带 deformation 的整包当前不能产生 GI ray-scene，仍恒排除作者的全局半球填充光。真实 SMT 作者强度 0.32、天空/地面双色因此丢失。仅已知 deformation packet 在 Studio 端显式允许原作者站位光；静态/未知包仍排除，替换静态包和 reset 撤销该条件，不添加固定光或修改核心 shader。实际画面差异仍须截图对照。

验证：作者灯投影、手势读取和环境合同三文件39项通过，包含变形包恢复原作者天空/地面颜色与强度、隐藏和零强度过滤、静态包替换及 reset 再次排除。后续完整 Web typecheck EXIT0。该结果验证参数消费；正式同镜截图和 CPU 性能待统一材质/GI构建后复测。

用户反馈 Deep 拖拽卡顿、锯齿和光照与 Three 明显不同。本轮限定 Studio 参数映射与合同验证，不修改 Deep 核心；同场景像素与 GPU 代价由主任务复测。Pages 完整编辑器仍安排在 Deep 修复之后。

## 现状核查

1. 已检索 Web viewer、Deep threeBridge/webgpu 的 AA、MSAA、DPR、ACES、曝光、灯光、环境与 GI 消费，以及未跟踪文件。现有桥、环境会话、阴影和性能诊断不重建。
2. 已读 DisplayContract、ScenePostProcessingState、RenderView、PbrRendererOptions。显示合同已有可选 `antialias.msaaSampleCount: 1 | 4`；普通场景状态没有另一套 MSAA 字段。
3. 已查 Web package：Three 0.186.1、现有 Deep 包、Vitest。硬件 MSAA、TAA 和空间 AA 已在核心，无需增加库。
4. 已沿 ViewerEngine → StudioDeepSwitchCandidate → DeepWebGpuBackend → openPbrRenderer → renderTargets 查真实创建路径；RenderView 读取作者相机、曝光、灯光与 DPR，环境会话读取已加载纹理。
5. 已查桥候选创建、灯光/曝光/环境、像素比例、MSAA 能力回退测试，以及现有 parity / AA 规格。GPU 像素差异不能由后端替身测试证明。
6. 已读 `antialiasing-master-plan-20261003.md`、`parity-gate-20261003.md` 与最新 Deep/发布顺序。核心已冻结构建，独立映射改动先通知主任务。

**已有（不重建）**：主 pass 默认 MSAA4、设备能力回退及帧遥测、TAA/空间 AA、Three ACES 对齐算子、作者曝光/相机/DPR、真实环境纹理、作者灯光与阴影投影。

**真实缺口**：Studio 普通场景的创建请求依赖核心隐式 MSAA 默认值，只有 A2C 明确请求4；GI 的 Three 半球站位光与 Deep 探针算法及强度消费不同；SMAA/FXAA 与 AO 参数尚未逐项同算法映射。用户当前严重锯齿仍需实际帧遥测核实是否是能力回退、旧包或后处理路径。

## 核查结论

| 项目 | 当前实际消费 | 结论 |
| --- | --- | --- |
| 相机 | Deep view 同步作者 eye/up/target、FOV/zoom、near/far | 已共享；拖拽尾延迟另测 |
| DPR | Deep 读取作者 renderer.getPixelRatio；两侧最高2 | 没有固定1x错配；动态分辨率是 URL 显式开启 |
| 曝光 | Deep 读取作者 renderer.toneMappingExposure | 天气/全局强度变化沿同值传入，无自动曝光覆盖 |
| ACES | 两侧使用 `three-aces-r185` 与现有 Three shader 适配 | 名称保留兼容值；不能仅据名称断言 r186 错配 |
| MSAA | Three antialias=true；核心省略采样数默认4，Studio仅A2C显式4 | 当前代码已有默认4；加强真实消费测试，不重复增加参数 |
| TAA / 空间 AA | authorDirectDisplay 会关闭时域抖动与空间 present AA；MSAA仍独立 | 不能用静置TAA代替拖动AA；需读 `FrameMetrics.msaa` |
| IBL | 环境原纹理解码、原 environmentIntensity；无环境时强度0 | 中性源存在不等于作者显示会加亮 |
| 作者直接灯光 | 同一Three灯的world方向、颜色、已应用强度与衰减投影 | 普通灯参数已共享；不支持类型明确报错 |
| GI | Three天蓝/地棕Hemisphere站位光；Deep排除并启用探针 | 原来只消费开关；本轮补强度消费。变形探针捕获缺口仍在，算法也不同 |
| 阴影 | 作者方向光mapSize/bias/normalBias/viewProjection | 作者合同已共享；Three地面ShadowMaterial helper不在Deep模型包 |
| 后处理 | Three MSAA+SMAA+Output；Deep MSAA会关闭legacy spatialAA且默认TAA | 算法有真实差异；AO仅开关映射、SMAA/FXAA未按作者选择映射 |

## 本轮调整

Studio 候选创建不改 MSAA 参数；测试把普通不透明场景和独立作者包的真实创建请求送入现有 MSAA 解析器，证明缺省请求实际为4。A2C材质仍强制4。后端能力探针保留自身回退与原因披露。

主任务随后授权最小 GI 核心消费扩展。RenderView 复用字段 `globalIlluminationIntensity`，0–16，SDK 缺省1。现有64B authored diffuse uniform 的 `constant.w` 保留槽写 `gain−1`；生产 shader 仅将有效 `gi.rgb` 乘 `max(1+constant.w,0)`，作者直接灯RGB、IBL、阴影和捕获源不变，不增加资源或绑定。Studio 读取 named GI 作者灯已应用天气/全局强度的实际 intensity，禁用时0，保持该站位半球光不参与 Deep 直接光投影。

当前变形场景探针捕获明确报 `baked or undeformed geometry snapshot`，仅保留 IBL。强度链补齐不能消除这个捕获缺口，也不意味着与 Three 半球填充画面等价；正式同场景 GPU 验收由主任务继续。

验证使用完整 Studio 桥切换事务捕获真实后端创建参数，覆盖普通不透明 Three 投影、直接显示、独立作者包与 A2C 重建/回退。像素、拖拽和帧预算待主任务同场景浏览器复测。

核心三文件31项测试通过（实际64B uniform 的0/0.5/2增益、原帧ABI、WGSL校验），Web桥三文件55项测试通过（含手势缓存、天气增益只消费一次、曝光/DPR/有色填充灯）。Deep typecheck 与8991源文件800行门禁通过。统一构建和后续GPU画面由 engine/main 任务接续，尚未记为像素等价完成。

远网格线索：`authorGridResources.ts` 的独立pass没有MSAA配置，主几何4x不覆盖它；已有完整线性光mip链与各向异性8采样。需要隔离网格pass并核对抖动投影与resolved depth，不能仅根据1x推断闪烁根因。变形快照工具仅复制source/pose，尚未找到当前skin/morph→静态ray geometry的生产烘焙消费。

## 作者网格现状核查（2026-10-07）

1. 已检索 contracts、Deep webgpu/textures 与 Web viewer，以及未跟踪文件；`sceneGrid`、`StudioDeepGridSession` 和独立 `AuthorGridResources` 是已有生产链。
2. 已读 `AuthorGridView`、`DecodedTexture`、采样器与 RenderView 合同；作者网格已有 model/color/fog/directDisplay，不需要新增场景设置。
3. 已查 Deep 包：已有 WebGPU/WGSL、Vitest、Three 0.186.1；不加依赖。
4. 已沿 Canvas → getImageData → 全 mip 准备 → GPU 上传 → `pbrRendererFrames` 的后置网格 pass 核查。网格与主几何共用 depthViewProjection，包含同一抖动；读取主4x sample0的解析深度，自己不写深度。
5. 已读资源/mip/生命周期测试及同相机 `qa-deep-1080-before-drag-fix.png`、`qa-three-1080-same-camera.png`。Deep 的远网格明显出现亮点；图中玻璃与主几何差异由其他任务处理。
6. 已查本规格、AA/parity 规格、handoff 与当前恢复顺序：Deep 修复优先，Pages 后置，README 不变。

**已有（不重建）**：同一200米 Canvas 网格、完整线性 sRGB mip、8x各向异性、真实 fog、相同相机投影与抖动、资源缓存与协作式 CPU 准备。现 mip 的 RGB/alpha 直通道平均保留原合同，不改成另一种 premult 纹理。

**真实缺口**：Studio 严格要求 ClampToEdge，但遗漏 sampler 地址字段，Deep 通用纹理默认 repeat；主几何4x使 legacy 全屏空间 AA 退出，后置网格仍单采样。后者是远线纹理覆盖闪烁的待实测候选原因，不能仅根据样本数断言根因。

最小处理复用现有纹理和附件：固定网格默认 clamp-to-edge；fragment 使用同一 UV 透视导数做四个¼像素覆盖采样，每个采样保持原 fog/display/premult 输出，再平均颜色与覆盖率。主几何、深度附件、mip 内容和帧资源不变。像素和 GPU 代价由主任务在隔离网格状态下实测后决定是否保留。

验证：`authorGridResources.test.ts` 9项通过，包含实际 WGSL 的 Naga 语义校验、GPU 上传采样器、单pass单采样附件合同、生命周期与同步/异步 mip 字节一致性。覆盖采样以独立解析信号验证：一个像素周期的线纹理在7种平移相位下平均覆盖率均为0.5，原单点随相位在0–1变化；常量/仿射细节一阶位置保持。该数值检查证明滤波性质，不代替真实 GPU 像素与耗时。Deep typecheck通过；3466文件source-size门禁0失败；限定改动diff检查通过。生产构建与实际场景验证由主任务继续。
