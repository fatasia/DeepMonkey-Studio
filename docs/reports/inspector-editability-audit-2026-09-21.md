# 3D 属性编辑能力审计

2026-09-21。依据当前源码和合同；本轮是静态链路审计，完整浏览器及正式包验收未执行。不存在于当前面板不等于整个引擎没有能力。

用户已确认本审计列出的缺失编辑能力本轮一次性补足，包括“继续逐字段核查”中经核实的缺口；不能只实现基础 PBR 后缩减范围。允许按依赖分切片并行，最终按完整清单统一验收。

布局验收：选中对象时保持稳定的信息顺序，公共信息→变换→渲染/材质→对象专属能力→数据/行为；场景级环境、烘焙与色彩保持明确场景作用域。常用项优先、高级项折叠，不创建与既有工具重复的独立编辑流程。沿用设计令牌，统一标签宽度、间距、数字精度、单位、输入提交与错误反馈。窄面板、长名称、多材质、多选混合值、空/加载/错误/锁定态，以及深浅主题集中验收，不以添加控件数量作为完成依据。

## 已有能力，继续复用

- AppStudioInspector：名称、颜色、透明度、显隐、锁定、变换、数据绑定、交互、动画、预制体、空间音频等入口。
- ObjectAppearanceEditor / MaterialTextureSettings：粗糙度、金属度、自发光、六类 PBR 贴图、UV 变换/动画、法线强度、实例颜色校正、线框、双面、屏幕材质。
- SceneLightingEditor / SceneEnvironmentPanel / ScenePostProcessingEditor：多类型灯光、环境贴图与天空、阴影/反射开关、抗锯齿、AO、SSR、Bloom、景深等。编辑入口在环境面板，不能计为全缺失。
- CameraNavigationPanel：导航速度、视点高度、重力、跳跃、轨道限制与裁剪；ScenePhysicsPanel：刚体类型、质量、摩擦、弹性及旋转关节。

## 确认缺口与实施顺序

| 优先级 | 缺口 | 证据与补齐要求 |
|---|---|---|
| 已完成（待最终视觉验收） | 多选公共属性 | `SceneMultiSelectionInspector` 已提供混合值、公共变换/材质、对齐/等距、锁定对象保留值及单事务历史；保留多 DPI/主题和复杂混合值的最终页面验收。 |
| 已完成基础链路（高级物理材质仍待补齐） | 材质编辑到 Native 发布 | 基础颜色、粗糙度、金属度、发光、双面与 IOR 已进入 RenderPacket/Native 合同并设有不支持项阻断；清漆/透射等高级物理字段仍不得静默丢弃。 |
| 已完成基础链路（资源级采样选项仍待补齐） | 材质槽与作用域 | 现有 `MaterialScopeEditor`、`slotOverrides`、稳定 `gltf:<index>` 身份和槽级恢复已接入对象/图层作用域；共享资源导入/实例覆盖边界需在最终发布验收中继续核对。 |
| P1 | 灯光合同字段缺控件 | 单灯编辑缺 distance、decay、penumbra、groundColor。深入子组件核查后确认 shadowSoftness、IES 已由 SceneSpotShadowEditor / SceneIesEditor 接通，不能因父组件无字段文本误判缺失。复用已有高级编辑器。 |
| P1 | 物理材质扩展 | IOR 已完成合同、验证、Three 物理材质升级、Deep PBR v5 与发布阻断；清漆、透射、厚度、吸收仍需合同、验证、渲染和发布一起扩展。透明度已有，不能代替玻璃透射。 |
| P1 | 精确材质输入 | 材质/UV 大量仅 range+output，缺数值直接录入；补可提交数值、逐项重置和合理范围，不用每键输入形成历史记录。 |
| P1 | 色彩管理作者设置 | 当前环境/后处理面板未提供曝光、白平衡与色调映射作者入口；已有实例色相/饱和度不等于完整 HDR 色彩管理。先审计底层固定值再接线。 |
| P1 | 烘焙作者设置 | 缺完整对象贡献/接收 GI、光照贴图密度、探针影响、烘焙质量/过期状态与增量生成工作流；不将几何 bake 算成光照 bake。 |
| P1 | BIM 自定义属性 | StructuredProperties 只有 dt/dd 展示。补作者自定义字段的类型、单位、枚举、校验与持久化；导入源属性保持来源，覆盖值与源值分开。 |
| P2 | 统一选择上下文 | 灯光、相机、物理主要在独立工具面板，右侧 Inspector 未形成统一组件式编辑。复用现有编辑器嵌入，避免复制业务逻辑。 |

## 继续逐字段核查，不宣称全缺失

- 对象级渲染：投射/接收阴影、GI 参与、LOD/剔除策略、渲染层与透明排序的作者语义、继承及发布能力。
- 相机：投影方式/FOV、正交尺寸、焦距/传感器，以及与现有景深焦点的归属和持久化关系。
- 物理：碰撞体形状/偏移、运动学、阻尼、轴锁、触发器与碰撞过滤。已有刚体/关节不得重复建设。
- 动画/行为/数据/音频：现有专用组件已接入；继续核对可配置字段、对象引用、运行状态与作者值分离，不能仅凭名称判定完成。
- 贴图资源：每槽 UV 通道/变换、采样/环绕、色彩空间、压缩与导入选项需要区分资源级和实例级；现有 UV 为共用变换。

## 交互与合同

基础/渲染/材质/行为/数据按对象类型组织，常用优先、高级折叠。统一数值提交、重置、复制/粘贴属性、覆盖标记、错误反馈和键盘行为；派生值与引擎内部句柄只读。字段定义应复用现有合同校验，明确类型、单位、范围、默认值、可用后端、持久化位置与命令，避免新增平行场景模型。

每个新增字段必须具备编辑→撤销→重做→保存→刷新→发布→运行消费证据。所有扩展仍遵守现有权限与锁定，不把 Native 不支持项静默丢弃。

对标：[Unity Inspector](https://docs.unity.com/en-us/engine/6000.3/manual/unity-editor/editor-windows-views-reference/using-the-inspector)、[Material Inspector](https://docs.unity.com/en-us/engine/6000.0/manual/materials-and-shaders/materials/class-material)。参考其按选中对象/组件/材质能力显示属性，非复制完整游戏制作套件。

## 灯光编辑切片（18:03）

现状复查发现 IES 导入、已有 profile 选择和聚光 shadowSoftness 控件已接通，保留 `SceneIesEditor` / `SceneSpotShadowEditor`，未重复建设。补齐 point / spot 照射距离与衰减指数、spot 光锥柔边、hemisphere 地面颜色；默认值与 `viewerEngineEnvironment` 一致。数值使用既有 DeferredNumberInput，失焦 / Enter 提交，继续走原 onUpdateLight 和场景保存历史。

主灯光列表与单灯编辑分离为 SceneLightingEditor / SceneLightEditor，参数职责独立为 SceneLightParameters，均小于 300 行。常用参数展开，IES 与聚光阴影放进原编辑器的高级折叠，使用现有设计令牌。

三个文件 20 项定向测试通过，覆盖灯类型适用性、参数默认值与边界、实际 onUpdate patch、IES / shadow 既有入口和 Native 灯光编译回归。编辑→撤销→保存刷新→正式产物及双主题视觉仍留统一验收。

后端差异保持明确：Three 消费全部本次新增字段；Deep WebGPU 局部灯当前要求有限距离与 decay=2，控件悬浮说明已标明。Native 编译已有 point / spot distance、decay、penumbra 消费；半球地面光仍不在现有 Native lighting 编译支持中，shadowSoftness 仍明确仅 Deep WebGPU。未放宽发布门禁，也未宣称灯光三端全对等。

### 后续灯光消费者接通（18:14，覆盖上段距离/衰减/半球缺口）

- Native 半球：编译保留线性天空/地面 RGB 与世界方向，运行包 `hemisphere/groundRadiance` 强校验，原 4×vec4 灯 ABI 保留，shader 按法线和半球方向混合天/地辐照并进入漫反射；不影响旧包直接灯字段。真实 `compileSceneRuntimePackage` 生成包可解析，灯光进入已编译证据与发布能力预检。
- Deep Web：作者 distance=0 原义保留为无限距离，CPU/GPU 聚类覆盖全部视锥格，不伪造远距离截断；decay 0–4 经世界灯、ABI、CPU 对照和 GPU PBR falloff 消费。Spot ABI 升至 v2 / 64 字节，新增衰减行；默认平方衰减保留原计算式。penumbra=0 用硬锥边界，不再以 ULP 扩锥；阴影无限距离使用 500m 默认投影远面。
- Native 真机：`renderer::solid_environment_tests::solid_background_survives_resize_and_failed_replacement` 通过，RTX 4060 Laptop GPU / Vulkan，57.85 秒。新增天空红/地面蓝的半球实际像素贡献与方向翻转差异断言；resize 保留灯光数据，既有点/聚光衰减、HDR/材质/阴影和失败替换回退同次通过。Rust 灯结构 2 项通过。
- 定向验证：Deep 首批 65 项通过 / 3 跳过，补充 32 项通过（7 项与首批重叠）；Web 灯桥与编译 24 项通过，Web 类型检查通过。深浅主题、Deep Web 新 ABI 真机像素和正式页面发布下载后运行仍归最终验收。Native shadowSoftness 尚未补齐，不能将本切片等同全部灯光或全部 Native 兼容完成。

18:17 收尾：半球漫反射已接材质 AO，同一 Native 真机回归重新通过（35.00 秒），日志 `test-output/hemisphere-native-gpu-2026-09-21.log`。另外核实创建灯光命令总会保存 target：点光/半球编译允许该作者字段，半球方向只来自 position，与 Three 一致，避免新增灯仍被预检拒绝。相关编译与发布预检 14 项复验通过。无限灯的重要性预算不再将 range=0 误算为零贡献，4 项测试通过。

### Native 聚光软阴影（18:29，覆盖上段 shadowSoftness 缺口）

作者 `shadowSoftness` 0–1 已经由灯光编译、运行包验证、Native 解码到真实 PCSS 消费，发布编译继续保留该值。Frame ABI 升至 `deep.native.frame.v7`，末尾新增 4×vec4（64B）容纳 16 灯参数；旧字段偏移不变、旧包缺值默认 0，阴影索引仍为整数。三个 Frame shader 声明同步更新。

正值执行 4 次遮挡物深度探测和 12 次 Poisson 比较采样，使用 Deep Web 相同半影公式及 4 texel 上限；采样限制在本灯深度层内。0 保留原 9 tap PCF，receiveShadow/castShadow 与局部阴影缓存规则保留。灯光控件文案已标明 Deep WebGPU 与 Deep Native 支持。

验证：Web 编译/真实运行包/发布能力预检 14 项、灯光编辑 4 项、Native ABI 全 16 灯独立参数与整数索引 1 项、灯结构校验 2 项通过；Web 类型检查通过。RTX 4060 Laptop GPU / Vulkan 真机回归通过（37.89 秒），包含显式 0 与缺省逐像素一致、柔化与旧 PCF 有实际像素差异、关闭接收阴影绕过，以及 resize 与替换回退。日志：`test-output/native-shadow-softness-gpu-2026-09-21.log`。

本切片不等于整页发布下载后运行验收，也未声称 Web 与 Native 阴影逐像素相同：两端已有深度图布局、PCF 基线、偏差策略不同，整体画面对比留最终统一验收。

### IOR 与高级材质 ABI（18:58）

折射率不是一个只显示在 Inspector 的数值。合同新增 `SceneMaterialState.ior`，验证有限 float32 且不小于 1；Three 标准材质在首次写入非默认值时升级为 `MeshPhysicalMaterial`，保留贴图、源材质快照、槽级覆盖和纹理恢复记录。默认 1.5 继续走旧介电响应，避免存量场景画面变化。

Deep 侧采用显式 `deep.pbr.mesh.v5` 材质实例 ABI：IOR 使用命名的实例字段，旧 `v1` 和自定义 shader 保留零 padding 语义；旧 ABI 收到非默认 IOR 时预检拒绝并说明原因。GLB `KHR_materials_ior` 源值已纳入解析和发布路径，默认值为 1.5。编辑器支持单选、多材质槽恢复和多选混合值。

验证：Web IOR/材质槽/发布恢复及 Inspector 17 项、contracts 场景验证 18 项、Deep PBR shader 定向 23 项（3 跳过）及 Deep 类型检查通过；Native shadow 相关单元测试 5 项通过。正式页面和 Native 下载产物画面对拍仍未执行；自定义旧 shader 的非默认 IOR 仍明确阻断，不冒充完整兼容。

### 色彩管理增量（2026-09-22）

沿用已有 `ScenePostProcessingEditor`、WebGL Composer 和 Deep WebGPU author color pass，新增可持久化的色温（temperature）与色调偏移（tint）参数。字段经过合同校验和默认值归一化，拖动控件不会新建平行渲染链；WebGL 与 Deep WebGPU 使用同一组有限范围参数并保持亮度归一。定向回归：Web 后处理/Deep 色彩 9 项、Deep author color 31 项、contracts 场景验证 18 项，类型检查通过。正式双主题页面、三端发布能力预检和像素对拍仍归最终验收；Native 未实现该作者后处理字段时继续由发布门禁显式阻断，不静默丢失。

### 对象碰撞字段补入 Inspector（2026-09-22）

复用既有 `ViewerEngine.setCollisionEnabled/isCollisionEnabled`、快照捕获和场景历史，在单选模型的对象概览中增加“碰撞检测”切换。锁定对象禁用，修改沿现有 `recordSceneEdit` 进入撤销/保存链路；模型构件子层不重复显示模型级开关。Web 类型检查和既有选择栏回归通过，正式双主题页面与键鼠操作仍归最终视觉验收。

2026-09-22 性能切片：ShadowCasterSet 现按最多14个视图槽缓存精确矩阵bit对应的投射物指纹；静态矩阵不再重扫所有投射物，shader版本仍独立进入key。场景prepare创建新集合、发布/回退随集合整体交换。审计同时修复旧transform-only仅写实例而不更新剔除/LOD/caster派生数据的问题：复用现有try_stage_scene_refresh，几何/纹理/材质零重上传；影响MASK阴影的uniform变更必须经过shadow relevance重建。

10k投射物/14视图release局部基准：静态1.085→0.009ms（-99.15%）；相机4变10静1.100→0.350ms（-68.20%）；物体逐步新集合1.065→1.148ms（+7.83%，没有复用收益）。这是key生成微基准，不能折算整帧FPS。修复后的变换小fixture debug stage+publish+GPU验帧49.184ms，包括同步GPU校验，不是纯编辑延迟；大型动态场景增量派生更新仍待优化。证据test-output/native-shadow-key-benchmark-2026-09-21.log。

4项定向测试通过；真实RTX4060 GPU移动投射物使指纹和画面变化、撤销逐像素还原，全套38.14s通过；两种原增量路径GPU2项通过。证据native-shadow-key-gpu-2026-09-21.log、native-shadow-fastpaths-gpu-2026-09-21.log。整个性能阶段未完成。
