# Dev Studio 产品与架构规划

状态：提案  
目标分支：`dev-studio`  
更新时间：2026-08-25

## 1. 产品结论

Dev Studio 应定位为“一套创作内核、两种使用方式、一个发布运行时”的 BIM 数字孪生应用开发平台：

- B/S：浏览器登录服务器后直接编辑、预览、发布和管理。
- C/S：使用 Tauri 2 构建本地编辑器，配置当前服务器地址，登录同一套服务器账号，拉取项目到本地工作区，编辑后发布回服务器。
- 账户和权限只有服务器一套，但登录入口可扩展为本地账号、飞书、企业微信及标准企业身份提供商。
- 三维运行时正式支持 WebGPU，并以 WebGL 2 作为兼容回退；迁移期 WebGL 2 保持生产默认，能力对齐后切换为“Auto：优先 WebGPU、自动回退 WebGL 2”，同一项目不能维护两套业务逻辑。
- 默认进入二维看板编辑器；只有用户主动点击“进入三维编辑”，或双击二维画布中的三维场景组件，才进入三维场景编辑器。
- 二维和三维编辑界面分开，但共用项目、数据、变量、事件、动作、版本和发布模型。编辑入口分开，运行逻辑不能割裂。
- 发布对象从单个 `SceneSnapshot` 升级为完整的 `ApplicationDocument`，一次发布固定二维页面、三维场景、数据绑定、资源和交互版本。

不建议维护两套前端，也不建议让 Tauri 加载远程服务器页面并直接开放本地权限。桌面端应打包同一套前端代码，通过受限 Host Adapter 获得本地能力。

### 1.1 范围收敛

Dev Studio 不是重型地理空间平台，也不是复刻 Unity 的游戏引擎。当前明确保留：

- 通用资源转换插件、独立拓扑编辑器、城市地图底板和轻量 GIS。
- 轻量 GIS 只覆盖在线/离线底图、坐标转换、GeoJSON 点线面、标记/轨迹/区域、二维地图组件、三维底图层和二三维地理定位联动。

M0 至 M6 明确不做：

- 3D Tiles、倾斜摄影、海量地形/点云和城市级三维流式加载。
- GPU 云渲染链路；保留对象 ID、输入事件、Renderer/Scene Port 和可序列化发布包，M7 最后实施。
- 二维组件与三维设备统一的“定义 → 变体 → 实例覆盖”系统。
- 为可能永远不会使用的格式、渲染后端或分布式规模预建抽象。

核心范围收敛为：专业二维看板、独立拓扑、轻量地图、可高度定制的工业三维场景、统一数据与交互、本地编辑与服务器发布。目标不是内置 Unity 或飞渡的全部能力，而是在 Web/Tauri 工业数字孪生范围内提供足够稳定的扩展点，使复杂需求不必修改编辑器核心。

### 1.2 重构与工程原则

采用“模块化单体 + 端口/适配器 + 能力插件”架构，不拆微服务，不同时重写全部代码：

```text
apps/web、apps/desktop
        │
    Studio Shell（路由、布局、项目上下文）
        │
┌───────┼────────┬──────────┬────────────┐
│Dashboard   Topology   Map/Geo   Scene   Data   Interaction/Publish│
└───────┼────────┴──────────┴────────────┘
        │
Studio Core（文档、命令、撤销、选择、引用、事件契约）
        │ ports
Three WebGPU/WebGL / Browser / Tauri / Server adapters
```

约束如下：

- 依赖只向内：UI 可以依赖 feature public API，feature 可以依赖 Core；Core 不依赖 React、Three.js、Tauri、网络或具体存储。
- Dashboard、Topology、Map/Geo、Scene、Data 等模块只能通过公开入口、稳定 ID、命令和事件契约协作，不跨目录读取对方内部 store。
- Three.js 与具体渲染后端封装在 Scene/Renderer Adapter；业务脚本面向版本化 `studio.scene` API，避免切换 WebGPU/WebGL 或升级渲染引擎时修改所有业务代码。
- 撤销、选择、属性 schema、快捷键、剪贴板、时间轴、变量、事件和资源引用各实现一次，由二维和三维复用。
- 模块先保持在单仓库和单部署中；只有形成独立发布、独立故障或明显构建边界时才拆包。
- 抽象必须对应稳定边界或至少两个真实实现；一次性逻辑保持局部，拒绝万能 Service、万能 EventBus 和无业务含义的工具层。
- 迁移以垂直切片进行：先建立新接口和回归测试，再迁移一条用户流程，最后删除旧路径；禁止新旧实现无限双轨。
- 每个模块只暴露 `index.ts` 公共 API；CI 检查跨模块深层导入、循环依赖、重复代码、类型错误、测试和构建预算。

关键决定记录在 [ADR-0002 模块化编辑器内核](./adr/0002-modular-editor-core.md)、[ADR-0003 分级场景扩展运行时](./adr/0003-tiered-scene-extension-runtime.md)、[ADR-0004 轻量 GIS、拓扑与转换边界](./adr/0004-lightweight-geo-topology-and-conversion.md)、[ADR-0005 WebGPU 优先渲染](./adr/0005-webgpu-first-rendering.md) 与 [ADR-0006 最后实施 Tauri/云渲染](./adr/0006-stage-desktop-and-cloud-rendering-last.md)。

## 2. 竞争策略

“超过所有竞品”不能只按组件数量衡量。阶段目标应拆成九条可测试的产品轴：

| 能力轴 | 主要对标 | Dev Studio 取胜方式 |
| --- | --- | --- |
| 二维搭建效率 | FineVis、山海鲸、森大屏 | PPT/Figma 级画布、图层、组合、对齐、模板、快捷键、地图和拓扑 |
| 数据分析深度 | FineReport/FineBI | 语义数据集、字段计算、公式、数据预处理脚本、联动过滤上下文 |
| 三维场景深度 | ThingJS、Unity、51WDP | 保留当前 BIM/CAD、构件、空间、剖切和工业视觉优势，补齐相机、Mesh、材质、动画、角色控制和工业运动能力 |
| 二三维编排 | FineVis、51WDP | 统一事件图和变量作用域，二维与三维双向联动、可视化调试 |
| 低代码易用性 | 山海鲸 | 自动联动、条件样式、向导、模板、实时预览、错误可定位 |
| 专业扩展 | ThingJS、Unity、51WDP | 公式、行为脚本、场景能力 SDK、可信插件、数据连接器 SDK 和资源转换器 SDK |
| 本地交付 | 山海鲸、ThingStudio | Tauri 本地工作区、一键发布、私有化服务器、断点续传和回滚 |
| 运行时性能 | ThingJS、Unity、51WORLD | WebGPU 优先/WebGL 2 回退、模型索引、实例化/合批、按需加载、Worker、渲染预算和确定性仿真时钟 |
| 企业治理 | FineReport | 单一账号体系、项目权限、发布权限、版本、审计、兼容性握手 |

近期不追求复制竞品的海量底图素材、报表和城市模型库存。第一阶段先在“工业 BIM 数字孪生 + 二三维一体化 + 轻量地图/拓扑 + 私有部署”上形成明显优势，再补齐通用 BI 长尾能力。

## 3. 竞品交互借鉴

只借鉴通用交互范式，不复制品牌视觉、图标、文案或专有素材。

| 来源 | 借鉴点 | Dev Studio 落地 |
| --- | --- | --- |
| FineVis | 看板中添加三维组件，再点击“编辑组件”进入三维场景编辑；属性按内容、样式、动画、交互组织 | 二维画布使用 `SceneViewportWidget` 引用三维场景；双击或右上角按钮进入三维编辑，返回时回到原页面和原组件 |
| FineVis | 图层层级选择、组合、锁定、隐藏、右键批量操作、快捷键 | 统一图层树和画布选择模型，支持 Ctrl/Shift 多选、组内选择、锁定、隐藏、拖动层级和右键菜单 |
| FineVis | 一个事件下可配置多个动作，动作包括联动、跳转、显示隐藏、三维视角和动画 | 事件编辑器采用“触发器 → 条件 → 动作序列”，动作可排序、复制、禁用、单步测试 |
| 山海鲸 | 项目级公共数据源、字段驱动的自动联动、联动白名单/黑名单 | 数据集默认参与同字段/语义字段联动，允许指定目标范围，并显示联动关系图 |
| 山海鲸 | 条件样式、多状态、组件搜索、组件套件、图层拖动 | 增加状态规则、条件格式、Ctrl+F 组件命令面板、业务组件套件和收藏 |
| 山海鲸 | Element API 可读写组件属性、读数据、触发/撤回联动、监听与派发事件 | 提供受限 `studio` SDK，不把 DOM、`window`、Three.js 全局和原始网络权限直接暴露给脚本 |
| 森大屏/ThingJS | 选择模板、拖拽组件、调整样式/事件、接入数据；二维界面可与三维对象结合 | 保持四步主流程，在三维场景组件、空间标记和二维浮层之间提供统一绑定 |
| ThingStudio | 将数据接入、场景、大屏、拓扑和发布组成连续工具链，资源与插件可复用 | 二维、三维、拓扑、地图和数据使用同一项目上下文、变量、事件、资产引用和发布包，编辑模式分开但工作流不断裂 |
| 飞渡 DTS | 数据处理、场景编辑、地图资源和应用开发职责分层 | 保留可取消/可诊断的转换任务与轻量底图；不引入 3D Tiles/倾斜摄影，云渲染仅在 M7 作为可选交付模式 |
| Unity Hierarchy/Inspector | 层级树分开控制可见性和可选取性；对象能力由组件组成，Inspector 根据组件暴露属性 | 图层/场景树同时提供显示、可选取、锁定三个独立状态；属性面板由组件 schema 生成，支持多选批改、面板锁定和组件排序 |
| Unity Scene/Game、Timeline | 创作视图与最终运行视图分离，Play 模式验证行为；复杂序列使用时间线 | 二维和三维均提供“设计/预览运行”状态，运行态使用明显边框且不静默写回；动画、镜头、告警演练共用多轨时间线和事件标记 |
| ThingJS API / Unity Script | 通过脚本生命周期和场景 API 操作对象、相机、材质、动画、输入与事件 | 提供分级 `SceneCapabilitySDK`；常规行为在沙箱运行，主线程渲染命令批量提交，只有管理员安装的可信扩展能注册底层渲染能力 |
| Unity Build Profiles | 设计态与构建目标分离，不同目标拥有独立入口和配置 | 仅保留本地预览和服务器 Web 两种发布配置，共用一个业务文档和运行时 |
| 51WDP | 场景、面板、交付分阶段；蓝图节点编排场景与画布联动；场景支持版本增量 | 项目管理中明确“页面、场景、数据、发布”；第二阶段增加可视化交互图，发布采用不可变版本和增量资源 |

调研后的取舍：

- 学 ThingJS 的连续生产链、场景 API 和插件化，但 Dev Studio 的二维页面、三维场景和数据必须由一个 `ApplicationDocument` 原子交付。
- 学飞渡的数据处理/编辑职责分离和地图资源组织，保留轻量 GIS；3D Tiles、倾斜摄影和重型大场景处理不进入范围，云渲染仅在 M7 最后实施。
- 学 Unity 的 Hierarchy、Inspector、设计/运行分离、脚本生命周期和时间线，但不引入 Prefab 变体体系或游戏开发复杂度。
- “借鉴交互”只借鉴已成为行业惯例的行为模型，不复制竞品视觉、文案、图标、素材或实现代码。

官方参考：

- [FineVis 组件操作及快捷键](https://help.fanruan.com/finereport/edition-view-57699-0.html)
- [FineVis 组件交互属性](https://help.fanruan.com/finereport/doc-view-4214.html)
- [FineVis 三维自定义场景组件](https://help.fanruan.com/finereport/edition-view-57816-0.html)
- [山海鲸编辑子看板图层](https://www.shanhaibi.com/docs/v1/bsimp1/)
- [山海鲸 Element 类](https://www.shanhaibi.com/docs/v1/lvvsdz58obwbxqtn)
- [山海鲸数据读取和处理](https://www.shanhaibi.com/docs/v1/bs6qnxudp34frgq7/)
- [ThingJS 森大屏](https://www.thingjs.com/guide/chartBuilder/)
- [ThingJS 官方指南](https://www.thingjs.com/guide/)
- [ThingStudio 数字孪生工具链](https://www.thingjs.com/guide/studio/)
- [ThingJS 2D/3D 界面](https://docs.thingjs.com/cn/App_dev/Tutorial/Content/UI.html)
- [飞渡 DTS 产品架构](https://www.freedoonline.com/dts.html)
- [飞渡 DTS 官方文档](https://doc.freedo3d.com/)
- [Unity Hierarchy 窗口](https://docs.unity3d.com/cn/6000.0/Manual/hierarchy-reference.html)
- [Unity Game View 与 Play Mode](https://docs.unity3d.com/kr/current/Manual/GameView.html)
- [Unity Timeline](https://docs.unity3d.com/ja/6000.0/Manual/com.unity.timeline.html)
- [Unity Build Profiles](https://docs.unity3d.com/jp/current/Manual/build-profiles-reference.html)
- [Three.js WebGPURenderer](https://threejs.org/manual/en/webgpurenderer)
- [Three.js WebGPU 后处理](https://threejs.org/manual/en/webgpu-postprocessing.html)
- [51WDP 产品与创作流程](https://wdp.51aes.com/product-service5?loggedIn=false)

## 4. 核心用户流程

### 4.1 项目入口

登录后进入项目中心，而不是直接进入某个三维场景。

1. 选择或新建项目。
2. 默认打开项目的首页二维看板。
3. 顶部模式切换仅保留“二维设计”“拓扑”“三维场景”“数据”“预览”；地图作为二维组件和三维图层配置，不再增加一个一级编辑器。
4. “发布”始终位于右上角，显示未保存、未同步、校验失败和目标服务器状态。

### 4.2 二维编辑器

```text
┌ 项目 / 页面 / 二维设计 ─────────── 保存状态 ─ 预览 ─ 发布 ┐
├ 页面与组件库 ┬──────────── 画布 ────────────┬ 属性面板 ┤
│ 页面         │ 标尺、参考线、吸附、缩放      │ 内容     │
│ 图层         │ 多选、组合、容器、断点预览    │ 数据     │
│ 组件         │ 3D 场景作为一种可调整组件     │ 样式     │
│ 素材/模板    │                                │ 动画     │
│ 数据         │                                │ 交互     │
└──────────────┴────────────────────────────────┴──────────┘
```

关键交互：

- 固定画布和响应式画布都支持，首期默认 1920×1080 固定画布。
- 拖入、双击添加、搜索添加三种方式并存。
- 支持撤销/重做、复制/粘贴、重复、对齐、等距、吸附、编组、容器、锁定、隐藏、图层排序。
- 图层树的“可见”“可选取”“锁定”分开控制，避免为了看见背景而误选，也允许选择隐藏对象的子项策略独立配置。
- 属性面板固定为“内容、数据、样式、动画、交互”，不同组件只替换面板内容，不改变信息架构。
- 画布组件显示真实数据的采样预览，编辑时明确标记“设计数据/实时数据”。
- 每个组件都有空、加载、部分、错误、无权限五种状态预览。
- “设计态”和“预览运行态”明确分离；预览中的变量、筛选和动画不污染设计文档，用户可显式将需要的状态保存为默认值。

### 4.3 三维编辑器

```text
┌ 项目 / 场景 / 三维编辑 ─ 返回使用它的二维页面 ─ 预览 ─ 保存 ┐
├ 场景树与资产 ┬──────────── 三维视口 ───────────┬ 属性面板 ┤
│ 模型/构件    │ 选择、变换、测量、剖切、漫游    │ 对象     │
│ 灯光/环境    │ 相机视角与书签                  │ 材质     │
│ 标注/特效    │ 数据驱动效果即时预览            │ 数据     │
│ 数据绑定     │                                  │ 动画     │
│ 交互关系     │                                  │ 交互     │
├──────────────┴──────────── 时间线/蓝图调试 ─────┴──────────┤
```

进入方式：

- 顶部“进入三维编辑”。
- 双击二维画布中的三维场景组件。
- 在二维组件交互中选择某个三维目标时，点击“定位并编辑”。

返回二维时必须保留页面、组件、缩放、选区和滚动位置。三维场景可被多个二维页面引用，编辑三维场景后所有引用处更新，但已发布版本只有再次发布才变化。

场景树沿用和二维一致的选择语法：可见、可选取、锁定分别控制。模型、Mesh、材质、镜头、动画、行为和数据绑定都作为场景对象的可编辑能力呈现，但不引入统一 Prefab/变体/实例覆盖系统。

#### 4.3.1 高度定制的场景能力

`SceneCapabilitySDK` 提供稳定、可组合的能力域：

```text
studio.scene       场景、对象树、选择、查询、生命周期
studio.object      创建、克隆、删除、父子关系、Transform、显隐、图层
studio.mesh        几何、Mesh、实例化、射线拾取、裁剪与包围盒
studio.material    材质参数、纹理、颜色、透明、状态效果
studio.camera      视角、FOV、near/far、投影模式、飞行与跟随
studio.controls    轨道、漫游、第一人称、第三人称及自定义控制器
studio.animation   Clip、骨骼、Morph、Tween、状态机、混合与事件
studio.timeline    多轨序列、镜头、拆解步骤、关键帧、播放与跳转
studio.input       键鼠、触摸、选择和自定义操作映射
studio.data        实时值、时间戳缓冲、插值、变量和数据绑定
studio.runtime     仿真时钟、fixedUpdate、事件队列、暂停、倍速和回放
```

材质与后处理的新扩展优先使用 TSL/Node Material，以同时生成 WebGPU 的 WGSL 和 WebGL 的 GLSL。旧 `ShaderMaterial`、`onBeforeCompile` 与 `EffectComposer` 场景先走 WebGL 兼容路径，并在编辑器显示后端限制；发布校验不得静默丢失材质或效果。

场景行为脚本采用明确生命周期：`onStart`、`onUpdate`、`onFixedUpdate`、`onData`、`onEvent`、`onStop`、`onDispose`。脚本操作的是稳定 ID 和能力接口，不长期持有 React 或 Three.js 内部对象。

复杂工业场景由少量正交能力组合，不为每个项目硬编码专用功能：

- 设备拆解：对象层级与旋转轴/约束 + 可逆时间线步骤 + 镜头和标注事件。
- AGV 实时运动：路径/样条 + 统一仿真时钟 + 带时间戳遥测缓冲 + 插值/短时外推 + 断流状态。
- 机器人运动：关节层级、坐标系、限位和运动曲线 + 实时关节数据映射；逆运动学作为可选扩展，不耦合核心。
- 物流节拍：状态机 + 事件队列 + 工位/载具变量 + fixed timestep + 倍速、暂停、记录和确定性回放。
- 第一/第三人称：可切换控制器 + 目标跟随 + 输入映射；碰撞、重力和导航按项目以插件启用。

这里的“可实现 ThingJS/Unity 类复杂功能”指工业 Web 场景的可扩展性，不承诺复刻 Unity 的完整物理、游戏平台、渲染管线和资产生态。没有稳定通用 API 的底层需求通过版本化 Scene Extension 插件扩展，而不是向核心持续增加特例。

#### 4.3.2 ThingJS 级可编程性门槛

可编程性与扩展性是 M0 至 M6 的前置约束，不是 M6 才补的附加功能。对标 ThingJS 的目标是达到其“统一应用入口 + 对象 API + 事件 + 相机/控制器 + 组件扩展 + 数据接入 + 发布”的开发自由度，同时用版本化接口和分级运行时降低脚本直接耦合引擎内部的风险。

| 能力面 | Dev Studio 必须达到的公开能力 | 验收方式 |
| --- | --- | --- |
| 应用与对象 | 加载/卸载、稳定 ID、创建/克隆/删除、父子关系、搜索、批量查询、属性与选择 | API 合同测试；示例不得导入引擎私有模块 |
| 事件与生命周期 | 对象/场景/输入/数据事件；`onStart/onUpdate/onFixedUpdate/onData/onEvent/onStop/onDispose` | 顺序、取消订阅、异常隔离和确定性回放测试 |
| 相机与控制器 | position/target、near/far、FOV、投影、fit/flyTo/lookAt、世界屏幕转换、轨道/漫游/第一/第三人称 | 双渲染后端合同测试和交互样例 |
| Mesh、材质与效果 | 几何、实例化、材质/纹理、裁剪、拾取、状态效果，以及可信扩展的自定义渲染出口 | capability/后端兼容矩阵；不支持时给出可定位诊断 |
| 动画与工业运行时 | Clip、骨骼/Morph、Tween、状态机、时间线、fixed timestep、遥测插值、暂停/倍速/回放 | 拆解、AGV、机器人、物流节拍只用公开 API 实现 |
| 数据与二维联动 | HTTP/WSS 经授权连接、变量、数据绑定、批量命令、二维/三维/拓扑/地图统一事件语义 | 联动追踪和消息预算测试 |
| 组件与插件 | 安装/卸载、manifest、语义版本、能力权限、编辑面板、动作、数据连接器、转换器、地图 Provider、Scene Extension | 第三方示例插件不改核心代码即可加载和禁用 |
| 开发者体验 | TypeScript 类型、自动补全、API 文档、示例、日志、性能分析、生命周期调试、兼容检查和迁移说明 | SDK 发布门禁与文档/示例 CI |

公开 API 以 `SceneCapabilitySDK`/命令/查询/事件为唯一长期兼容面。普通脚本不能把 `ViewerEngine`、Three.js、DOM、令牌或宿主对象作为稳定依赖；确需底层渲染能力时走管理员签名的 Scene Extension，并声明 API 版本、权限与 `webgpu/webgl2/local/cloud` 兼容范围。

达到门槛的判定不是 API 数量，而是：四个工业参考项目完全不改核心、脚本和插件可独立升级/禁用、引擎升级有兼容检查、扩展失败可隔离、同一业务脚本在 WebGPU 与 WebGL 2 上保持业务语义一致。

### 4.4 独立拓扑编辑器

拓扑是独立编辑模式，不塞进普通二维画布的图层系统：

```text
节点库/数据 ── 拓扑画布 ── 属性与数据绑定
                 │
        端口、连线、分组、折线/曲线、对齐、自动布局
```

`TopologyDocument` 保存节点、端口、边、分组、布局和数据绑定。拓扑可作为 `TopologyViewportWidget` 嵌入二维页面，也可独立全屏运行。拓扑节点可以绑定数据实体、二维组件或三维对象；点击节点、三维设备或告警列表都通过同一 `InteractionFlow` 双向定位。首期支持平台 JSON 与 SVG/PNG 导出，Visio 等外部格式仅通过转换插件按真实需求增加。

### 4.5 城市地图底板与轻量 GIS

地图能力由一个 `MapProvider` 适配层供二维地图组件和三维地面底图共同使用：

- 在线 XYZ、WMTS/WMS 栅格底图，以及服务器托管或 Tauri 缓存的离线瓦片。
- GeoJSON 点、线、面，标记、轨迹、区域、聚合、热力和基于数据的样式。
- 明确记录坐标系，提供 WGS84、GCJ-02、BD-09 与项目局部坐标的受控转换；转换和纠偏不可隐式发生。
- `GeoAnchor` 将三维场景局部坐标映射到经纬度，使地图点选、三维定位、轨迹和告警使用同一实体 ID。
- 地图服务 URL、访问令牌、版权标识、可离线范围和缓存上限由服务器 Provider 配置，项目只引用 `providerId`。

轻量 GIS 不承担地形分析、空间数据库、海量矢量切片生产、3D Tiles、倾斜摄影或城市级三维流式加载。底图不可用时，页面和三维模型仍可编辑，地图组件显示明确降级状态。

### 4.6 二维、拓扑、地图与三维不割裂的机制

二维页面中的三维不是截图，而是 `SceneViewportWidget`：

- `sceneId`：引用的三维场景。
- `cameraViewId`：该组件的默认视角。
- `renderMode`：实时、交互时加载、静态占位。
- `interactionPolicy`：仅展示、点击选择、完整导航。
- `overlaySlot`：允许二维标签和控件相对三维视口定位。

统一联动示例：

- 点击二维柱图“3 号厂房” → 设置全局筛选 → 三维隔离厂房 → 相机飞行 → 右侧表格刷新。
- 点击三维泵机 → 写入 `selection.assetId` → 二维指标卡、趋势图和工单表自动刷新。
- 视觉告警 → 三维目标红色高亮 → 二维告警列表新增记录 → 页面弹出确认动作。
- 切换时间范围 → 图表和三维热力/状态动画使用同一时间上下文。

所有联动通过统一运行时完成，不允许组件彼此直接持有 React、地图引擎或 Three.js 对象引用。

## 5. 统一项目数据模型

建议新增 schema v2：

```text
ApplicationDocument
├── metadata
├── pages[]: DashboardPageDocument
│   └── nodes[]: WidgetNode
│       └── SceneViewportWidget -> sceneId + cameraViewId
├── topologies[]: TopologyDocument
├── scenes[]: SceneDocument
├── geo: GeoConfiguration
├── data
│   ├── connections[]
│   ├── datasets[]
│   ├── transforms[]
│   └── variables[]
├── interactions[]: InteractionFlow
├── scripts[]: ScriptModule
├── assets[]: AssetEntry
├── timelines[]
└── publicationProfiles[]
```

`InteractionFlow` 使用统一对象引用：`page/widget/topology/node/edge/map/feature/scene/object/layer/component`。事件负载统一包含 `source`、`selection`、`filters`、`variables`、`timeRange` 和 `originalPayload`。

`SceneDocument` 保存对象树、相机、控制器、环境、动画、行为和数据绑定；复杂逻辑由 `ScriptModule`、`InteractionFlow` 和 `Timeline` 引用稳定对象 ID。`TopologyDocument` 与 `GeoConfiguration` 只保存业务内容和 Provider 引用，不保存地图密钥。`AssetEntry` 保存资产 ID、类型、内容哈希、转换器版本、位置和必要元数据；页面、拓扑、地图、场景和脚本不得写易变的绝对路径。

当前 `SceneSnapshot.dashboard` 需要迁移为一个页面和一个 `SceneViewportWidget`，原三维场景本身保持不变。v1 文件继续可导入，保存后升级到 v2；旧发布链接在迁移期继续工作。

## 6. 数据、公式与脚本

### 6.1 数据链路

```text
连接器 → 数据集查询 → 预处理 → 字段/公式 → 聚合/过滤 → 组件绑定
                                             ↘ 三维对象绑定
```

数据源仍由服务器连接，浏览器和 Tauri 前端都不直接保存数据库、PLC 或 MQTT 密码。Tauri 可以保存服务器登录令牌，但数据源凭据只保存在服务器凭据库。

### 6.2 公式编辑器

公式适合 80% 的配置，不应要求用户写 JavaScript。首期提供：

- 字段引用：`[temperature]`、`[device.status]`。
- 条件：`IF`、`CASE`、`COALESCE`。
- 数学、字符串、日期、数组和聚合函数。
- 全局变量：`$selection`、`$filters`、`$timeRange`、`$user`。
- 自动补全、函数说明、类型提示、示例输入、结果预览、错误位置。
- 公式 AST 保存，禁止用 `eval` 执行。

### 6.3 脚本编辑器

脚本和扩展分为三个等级，既保持默认安全，又不封死专业能力：

1. 公式/配置：覆盖常用数据与交互，不执行任意代码。
2. 项目行为脚本：数据处理、组件交互和场景行为在独立 Worker 沙箱执行，只能调用声明过的 capability；场景修改以批量命令提交给主线程，限制时间、内存、消息频率、响应大小和网络域名。
3. 可信 Scene Extension：由管理员安装、签名并显式授权，可在主线程注册自定义 Mesh、材质、后处理、控制器或高频渲染行为。扩展使用版本化 Engine Plugin API，不能访问登录令牌和无关本地文件。

当前 `AsyncFunction` 在浏览器主线程直接运行并暴露 `ViewerEngine`、Three.js 和页面全局对象，只适合可信原型。schema v2 应标记为 legacy trusted script，提供迁移提示，新增项目默认使用沙箱脚本。

脚本编辑器必须包含格式化、类型声明、自动补全、运行日志、生命周期调试、暂停/单步事件检查、超时终止和权限清单。发布前静态检查脚本请求的能力。运行时为 `onUpdate` 和 `onFixedUpdate` 设置每帧预算，连续超限时停用脚本并保留诊断，任何项目脚本都不能拖死编辑器。

## 7. B/S 与 Tauri C/S 架构

```text
                         ┌──────── apps/web（同一套 React UI）───────┐
浏览器 Host Adapter ────┤                                            ├── Studio Core
Tauri Host Adapter ─────┤                                            ├── Data Runtime
                         └────────────────────────────────────────────┘── Dashboard/Topology/Map/Scene Runtime
                                      │
                                  Server SDK
                                      │ HTTPS/WSS
                                  BIM Studio API
```

建议仓库调整：

- `apps/web`：继续承载共享 React 编辑器和 B/S 入口。
- `apps/desktop`：Tauri 2 配置、Rust commands、安装包、自动更新和系统菜单。
- `packages/studio-core`：文档 Store、命令系统、撤销重做、选择、剪贴板、迁移。
- `packages/studio-runtime`：变量、过滤、事件、动作、公式和通用脚本 capability。
- `packages/scene-runtime`：Scene Port、Three.js Adapter、相机/控制器、动画、时间线、行为运行时和 Scene Extension API。
- `packages/converter-contracts`：转换器 manifest、任务、产物、日志和兼容协议；不包含具体格式实现。
- `packages/server-sdk`：服务器地址、登录、版本握手、项目同步、发布客户端。
- `packages/contracts`：只保留跨进程/跨网络协议和 schema。

Tauri 侧职责限制为：

- 本地项目目录、缓存和最近打开项目。
- 系统安全凭据存储。
- 文件选择、拖入、大文件哈希、分片上传。
- 启动受白名单约束的模型转换 sidecar。
- 自动更新、崩溃恢复、系统菜单和窗口。

资源处理采用小内核、插件式转换：

```text
模型/CAD/BIM/图片/视频/数据源文件
  → 导入与校验
  → 根据 MIME、扩展名和内容探测选择 ConverterPlugin
  → 可取消的转换任务（进度、日志、资源预算）
  → 内容哈希、缩略图和本地缓存
  → 以稳定资产 ID 被二维/拓扑/地图/三维引用
  → 发布时只上传缺失内容
```

`ConverterPlugin` 声明插件 ID/版本、输入类型、输出类型、配置 schema、执行环境和资源上限。相同输入哈希、转换器版本与配置应命中同一缓存产物。Tauri 通过受限 sidecar 执行本地转换，B/S 通过服务器隔离 Worker 执行；浏览器主线程不加载原生转换器。任务支持取消、超时、重试、失败清理和可定位日志。

首批只把现有真实模型转换能力迁入插件协议，再按项目需求增加格式；“通用”指统一插件接口，不代表首版内置所有格式。地图瓦片缓存/打包可以使用同一任务协议，但不建设 3D Tiles、倾斜摄影、海量地形或点云生产平台。

不得让远程页面直接获得 Tauri 文件系统或 shell 权限。Tauri 2 的 capability/permission 应按窗口和命令最小授权；sidecar 命令和参数必须白名单化。官方参考：[Tauri Capabilities](https://v2.tauri.app/security/capabilities/)、[Tauri Shell](https://v2.tauri.app/plugin/shell/)、[Tauri Updater](https://v2.tauri.app/plugin/updater/)。

## 8. 单服务器连接与登录

只有一套服务器账号系统。客户端不再建立本地业务账号。

### 8.1 首次启动/地址变化

1. 输入协议、IP/域名和端口。
2. 请求 `/api/meta`，校验服务器实例 ID、API 版本、功能能力、时间和证书。
3. 显示服务器品牌登录页。
4. 登录成功后进入项目中心。
5. 将短期访问令牌/刷新令牌写入系统安全存储，不保存密码。

客户端可保留最近连接地址，但同一时间只有一个活动服务器。每个本地草稿记录 `serverInstanceId + projectId + baseRevision`：

- IP/端口改变但 `serverInstanceId` 相同，允许继续同步。
- `serverInstanceId` 不同，视为另一套服务器，禁止静默覆盖，要求重新登录并重新关联或导入。

### 8.2 权限

保留管理员、编辑者、浏览者角色，并新增独立权限点：

- `project.read`
- `project.edit`
- `scene.edit`
- `data.manage`
- `publish.create`
- `publish.rollback`
- `user.manage`
- `audit.read`

角色只是权限模板，发布权限不要默认等同于编辑权限。后续可接 OIDC/LDAP/AD，但首期账号密码与现有用户表兼容。

现有浏览器 token 保存在 localStorage/sessionStorage，桌面版必须改由 Tauri 安全存储；API 需增加刷新、吊销、设备会话列表和登录失败限速。

### 8.3 开放登录入口

登录架构使用可插拔 `IdentityProvider`，不能在登录页和用户表中写死飞书或企业微信：

```text
本地账号 ───────────────┐
飞书 OAuth/免登 ────────┤
企业微信 OAuth/扫码 ────┼── Identity Broker ── 内部用户 ── 角色/项目权限
OIDC / SAML / LDAP ─────┘
```

外部身份只负责证明“是谁”，项目、场景、数据和发布权限仍由 BIM Studio 内部用户体系决定。建议新增：

```text
UserIdentity
├── userId
├── providerId
├── tenantId
├── subjectId
├── profileSnapshot
├── linkedAt
└── lastLoginAt
```

关键规则：

- 唯一身份键使用 `providerId + tenantId + subjectId`，不能只靠昵称、手机号或可变邮箱。
- 第一次外部登录采用“管理员预绑定/邀请”或受控的账号匹配规则；外部登录成功不能自动获得管理员权限。
- 支持一个内部用户绑定多个登录来源，并提供查看、绑定、解绑和审计；解绑最后一个可用来源前必须要求再次验证。
- Provider 的 App Secret、企业凭据和 token 只保存在服务器，绝不下发到浏览器或 Tauri。
- 使用一次性 `state` 防 CSRF；支持时启用 PKCE 和 `nonce`；OAuth 回调后签发 BIM Studio 自己的短期会话。
- 登录页从 `/api/public/auth/providers` 读取已启用入口，可按服务器部署情况显示“账号密码、飞书、企业微信、企业 SSO”。
- 保留受限的本地应急管理员登录，防止飞书/企微故障或配置错误导致整个系统无法管理。

B/S 直接使用服务器 HTTPS 回调。Tauri 使用系统浏览器发起登录，第三方平台回调先回到服务器，再用一次性授权结果通过自定义协议或短轮询交给客户端；Tauri 内嵌 WebView 不直接持有第三方登录 Cookie。

飞书和企业微信都要求在管理后台配置可信回调 URL/域。服务器 IP、端口可能变化时，应配置稳定域名、反向代理或虚拟 IP 作为 `publicBaseUrl`；如果 OAuth 对外地址也变化，管理员必须同步更新第三方平台回调设置，客户端不能绕过这一限制。

首批 Provider：

1. `local-password`，兼容现有账号密码。
2. `feishu`，支持浏览器授权/扫码和飞书工作台内免登。
3. `wecom`，支持普通浏览器扫码和企业微信内网页授权。
4. `oidc`，作为后续接入 Keycloak、Azure AD、Authing 等系统的通用入口。

参考：[飞书 Web 应用登录实践](https://open.feishu.cn/community/articles/7317091221654224898)、[企业微信 OAuth2 授权登录说明](https://s.apifox.cn/apidoc/docs-site/406014/doc-417796)、[企业微信扫码登录链接](https://s.apifox.cn/apidoc/docs-site/406014/doc-417799)。

## 9. 本地编辑、同步与一键发布

客户端工作区保存：

- 项目文档和操作日志。
- 资源内容寻址缓存。
- 服务器基线版本。
- 未同步改动和恢复点。
- 构建/校验结果，不保存服务器数据源密码。

项目提供可命名的 `PublicationProfile`。M0 至 M6 只包含“浏览器预览”和“服务器 Web”；M7 增加“Tauri 本地运行”和“服务器云渲染”。Profile 只保存入口页面、渲染模式、资源策略、环境变量引用和性能/兼容选项，不复制业务文档。开发、测试、生产可以共享内容但使用不同数据连接，凭据仍只在服务器解析。

发布流程：

```text
保存本地草稿
  → 与服务器基线比较
  → 检测远端冲突
  → 类型/引用/公式/脚本/资源/权限校验
  → 生成不可变发布包与差异摘要
  → 缺失资源分片上传、断点续传
  → 服务器二次校验
  → 原子激活新版本
  → 返回预览链接、版本号和审计记录
```

服务器必须保留上一个可运行版本，支持快速回滚。发布失败不能改变当前线上版本。客户端的“发布”弹窗明确显示服务器地址、当前用户、项目、版本差异、警告和发布后链接。

发布诊断必须列出入口页面/场景、缺失资源、脚本与扩展权限、包体积、预计首屏资源和运行时能力要求；日志能从界面中的问题定位到具体对象、资产、脚本或扩展。

## 10. 现有代码迁移重点

| 现状 | 问题 | 迁移方向 |
| --- | --- | --- |
| `apps/web/src/App.tsx` 同时承担路由、项目、场景、运行时和大量 UI | 继续扩展会让二维/三维拆分困难 | 先抽出 application store、command bus、host adapter，再拆二维与三维路由 |
| `SceneDashboardOverlay.tsx` 是三维视口内侧边浮层 | 无法成为独立专业看板编辑器 | 保留为 v1 兼容渲染器，新建全画布 DashboardEditor |
| `SceneSnapshot.dashboard` 与三维场景同寿命 | 页面无法复用多个场景，发布边界错误 | 升级为 ApplicationDocument，页面和场景独立引用 |
| `SceneDashboardWidgetState` 只有 12 种简单组件 | 缺容器、控件、地图、文本、形状、复杂图表和扩展机制 | 建立组件注册表、属性 schema、渲染器和数据角色定义 |
| 事件脚本直接使用 AsyncFunction 主线程运行 | 可阻塞、可越权、无法安全发布 | 公式优先、沙箱脚本、capability SDK、超时和审计 |
| `api.ts` 使用单一相对地址和浏览器存储 token | 无法适配 Tauri 可变服务器地址与安全存储 | ServerClient + ServerProfile + AuthStore adapter |
| 发布对象只有 PublishedSceneRecord | 不能原子发布二维、三维和交互应用 | PublishedApplicationRecord + immutable revision |

采用渐进迁移，不做一次性重写。每个阶段都要能读取已有项目、预览并回滚。

## 11. 分阶段路线图

以下估算按 5 至 7 人团队：2 名前端编辑器、2 名三维/图形、1 至 2 名后端/桌面、1 名产品设计与测试。人数更少时按依赖顺序推进，不要并行铺摊子。

### M0：架构地基，3 周

- 建立 schema v2、迁移器、Application Store、Command/Undo 系统。
- 建立模块 public API 与依赖规则，从 `App.tsx` 抽出 Studio Shell、Server SDK 和 Host Adapter。
- 定义 Scene Port、最小 Three.js Adapter 与架构测试，禁止 Core 反向依赖 UI/Three/Tauri。
- 定义 `SceneCapabilitySDK 1.0` 的命令、查询、事件、生命周期、能力权限和扩展 manifest；M0 只固化纯协议与兼容检查，不在此阶段迁移全部 ViewerEngine 实现。
- 增加 `/api/meta`、服务器实例 ID 和能力握手。
- 建立 IdentityProvider 接口、外部身份映射和登录入口发现协议，先保持本地账号实现。
- 为现有 v1 项目和发布链接建立回归夹具。

验收：旧项目无损打开；任一编辑命令可撤销/重做；浏览器 Host 不依赖 Tauri；SDK 合同不暴露 React、Three.js、DOM、HTTP 或宿主实现，脚本/扩展版本与能力请求可在运行前判定兼容性。

### M1：二维/三维编辑分离但运行统一，6 周

- 新建项目级路由、二维默认入口、三维独立入口。
- 新建 DashboardPage 和 SceneViewportWidget。
- 返回上下文、跨编辑器定位、统一变量和事件总线。
- 将当前侧边看板自动迁移为页面。

验收：用户从二维进入三维、修改并返回，二维组件状态不丢；四类二维到三维、三维到二维联动可配置并调试。

### M2：专业二维编辑器，8 周

- 完整图层树、组、容器、多选、对齐、吸附、标尺、参考线、快捷键、剪贴板；可见、可选取、锁定状态独立。
- 内容/数据/样式/动画/交互五类属性面板。
- 文本、形状、图片、视频、网页、指标、表格、基础/组合图表、筛选控件、Tab/轮播容器、弹窗。
- 增加轻量地图组件：Provider 选择、点线面/轨迹、数据绑定、基础样式和地图到三维对象的交互动作。
- 主题 token、业务组件套件和设计态五种数据状态。
- 设计视图与预览运行视图分离，支持常用工作区布局和属性面板锁定。

验收：典型 1920×1080 工业看板不写代码可完成；300 个普通组件编辑可用；关键操作均支持撤销；复制粘贴不破坏数据和交互引用。

### M3：数据、公式、联动和脚本，8 周

- 数据集语义字段、查询预览、计算字段、公式编辑器。
- 自动联动、手动作用域、白名单/黑名单、过滤上下文和联动图。
- 条件样式、多状态、数据驱动动画。
- Worker 脚本沙箱、capability SDK、日志、超时、发布检查。
- 提供 TypeScript 类型、自动补全、生命周期调试、命令批处理、权限清单和脚本 API 版本迁移诊断。

验收：公式有类型和错误位置；脚本死循环可终止且不阻塞 UI；脚本默认无法读取 DOM、令牌或任意本地文件；联动链可追踪到来源。

### M4：三维编辑器与 WebGPU 运行时，10 周

- 场景树批量操作、可见/可选取/锁定、选择集、规则着色、视角、多轨时间线、交互蓝图。
- 建立 Renderer Port 与三阶段开关：重构期 WebGL 2 默认/WebGPU 实验；能力对齐后 Auto 默认；稳定期新渲染能力 WebGPU/TSL 优先。Auto 运行时探测 WebGPU 并回退 WebGL 2，始终保留强制 WebGL 兼容模式。
- 新材质和后处理使用 TSL/Node Material 与 WebGPU RenderPipeline；旧 ShaderMaterial/onBeforeCompile/EffectComposer 由 WebGL 兼容路径承载并显示迁移诊断。
- 建立渲染能力矩阵、GPU/驱动信息、设备丢失恢复、材质/效果兼容检查，以及 WebGPU/WebGL 双后端视觉回归。
- WebGPU 优化优先落在实例化、粒子、数据驱动效果、MRT 后处理和适合的 Compute 任务；业务仿真结果不得依赖某个 GPU 后端。
- 完成对象、Mesh、材质、相机、near/far、投影、轨道/漫游/第一/第三人称控制能力。
- 完成 Clip、骨骼/Morph、Tween、状态机、多轨时间线、动画事件和数据驱动动画。
- 完成行为脚本生命周期、批量场景命令、fixed timestep、暂停/倍速/记录/回放和性能诊断。
- 提供设备拆解、AGV 路径与遥测插值、机器人关节映射、物流节拍四个可组合示例，不把示例逻辑写入核心。
- 数据标签、三维图表、热力、流线、路径、告警效果和状态绑定。
- 模型结构索引、实例化/合批、按需加载、GPU/内存预算和后台 Worker；不引入 3D Tiles、倾斜摄影与重型 GIS 引擎。
- BIM 版本对比、问题/视点、碰撞报告和空间关系继续深化。

验收：四个工业示例只通过公开 Scene API 实现；WebGPU 能力矩阵达到发布门槛后才将 Auto 设为默认，不可用或项目不兼容时可无损回退 WebGL 2；脚本可操作相机、对象、Mesh、材质和动画；固定基准集持续测双后端首屏、帧率、显存、脚本预算、视觉差异和发布包大小。

### M5：转换、轻量 GIS 与拓扑，8 周

- 建立 ConverterPlugin 协议、服务器隔离执行器、任务中心、进度/取消/日志/缓存；将现有必要模型转换迁入插件执行器。
- 轻量资产清单、内容哈希与服务器 Web 发布配置；支持大资源缓存、内容去重和缺失资源诊断。
- 完成 MapProvider、城市底图、在线/离线瓦片、GeoJSON 点线面、轨迹、区域、缓存与版权配置。
- 增加三维底图层、GeoAnchor、局部坐标/经纬度转换，以及地图、三维对象和轨迹的双向定位。
- 完成独立 TopologyEditor：节点/端口/边/分组、折线与曲线、对齐、自动布局、数据绑定、二维/三维联动和 SVG/PNG 导出。

验收：转换任务异常不影响编辑器且产物可复用；底图离线可降级；坐标黄金样本双向定位一致；1000 节点、2000 边的拓扑基准满足质量预算。

### M6：生态与企业化，持续 8 至 12 周

- 组件、动作、数据连接器和三维效果 SDK。
- 模板市场/私有组件仓库、依赖锁定和签名。
- Scene Extension SDK、签名与权限清单、自定义编辑面板、控制器、Mesh、材质和渲染效果插件。
- 发布稳定的 SDK 包、API 参考、版本兼容策略、迁移工具、开发模板、示例插件和 CI 合同测试；第三方扩展不得要求修改核心仓库。
- Converter SDK 与私有转换器仓库；地图 Provider SDK、离线瓦片包管理和缓存治理。
- 可保存/切换的工作区布局和扩展面板。
- 发布审批、版本比较、审计导出、SSO、备份恢复。
- 可访问性、触摸、国际化、多人评论与后续协同编辑。

### M7：Tauri 本地客户端与云渲染，最后实施，10 至 14 周

- `apps/desktop`、服务器地址向导、版本握手、同一账号登录、安全令牌、本地工作区、恢复点、大文件缓存和断点上传。
- Tauri 系统浏览器登录回调；实现飞书、企业微信 Provider，并验证地址变化与稳定回调域方案。
- Tauri 受限 sidecar 执行 ConverterPlugin；Windows 安装包、签名与自动更新，Linux/macOS 在验证需求后跟进。
- 发布差异、校验、原子激活、进度、失败恢复、回滚和 Tauri 本地运行 Profile。
- 增加 `RemoteRenderSession` Adapter、GPU Worker、会话调度、WebRTC 视频/音频、输入 DataChannel、鉴权、隔离、空闲回收和带宽/延迟监控。
- 云端运行与本地运行使用相同 ApplicationDocument、Scene Runtime、对象 ID、脚本语义和插件版本；插件声明 `local/webgpu/webgl2/cloud` 兼容能力。
- 云渲染不可用时，支持回退本地 WebGPU/WebGL 运行或显示明确不可运行原因，不影响项目编辑和已发布 Web 版本。

验收：服务器 IP/端口改变但实例 ID 相同可重新连接；断网编辑不丢草稿；发布中断不影响线上版本；固定内网基准中云渲染输入到画面 p95 低于 150 ms；GPU Worker 故障只终止对应会话且资源可回收。

## 12. 质量指标

- 自动保存后异常退出，恢复时最多丢失 5 秒编辑操作。
- 普通画布拖拽、缩放、选择 p95 响应低于 100 ms。
- 不含网络查询时，二维/三维联动动作 p95 低于 100 ms。
- 发布必须原子化，失败时线上版本零变化；任一已发布版本可回滚。
- schema 迁移必须有黄金文件测试，v1 导入覆盖现有示例和真实脱敏项目。
- 公式和脚本均有确定的超时、内存和输出上限。
- 浏览器和 Tauri 对同一发布包使用相同运行时，交互结果一致。
- 发布前必须发现缺失资源、绝对本地路径、不兼容脚本/扩展，并定位到具体对象。
- 四个工业参考项目及一个第三方示例插件必须只依赖公开 SDK；CI 禁止其导入 `ViewerEngine`、Three Adapter、React 状态或其他私有路径。
- Scene Capability API 遵循语义版本；同一 major 的兼容夹具持续通过，破坏性变更必须提供迁移器、兼容层或明确阻止发布。
- Worker 行为脚本可被终止，可信扩展可被单独熔断/禁用；任一扩展失败不得破坏项目文档、登录状态或其他扩展。
- 设计态、预览态和已发布版本的同一输入产生一致结果；预览运行产生的临时状态不得静默写回设计文档。
- Core 不得依赖 React、Three.js、Tauri 或 Server Adapter；CI 阻止跨 feature 深层导入、循环依赖和未声明公共 API。
- `onUpdate`/`onFixedUpdate` 有可观测的单帧预算；超限脚本可隔离停用，编辑器和其他场景行为继续运行。
- AGV、机器人和物流仿真统一使用带时间戳的数据缓冲与仿真时钟；相同输入事件可确定性回放。
- 相同输入哈希、转换器版本和配置必须产生可复用产物；转换任务可取消、超时、失败清理，插件不得获得未声明的文件或网络权限。
- 坐标转换、GeoAnchor 和地图/三维双向定位使用黄金样本测试；底图服务离线时不阻塞项目、拓扑和三维编辑。
- 1000 节点、2000 边的拓扑基准中，平移、缩放和选择 p95 低于 100 ms；自动布局在 Worker 中执行且可取消。
- WebGPU 与 WebGL 2 使用同一场景黄金样本做截图、交互和性能回归；后端降级必须记录原因，不能静默丢失材质、后处理、拾取或动画。
- WebGPU 设备丢失或初始化失败可恢复/回退；发布包列出所需渲染能力，插件和效果必须声明 `webgpu`、`webgl2` 或 `both`。
- 每个里程碑必须包含空、加载、错误、无权限、离线、冲突和升级失败状态。

## 13. 第一批开发 Epic

1. `EPIC-001` ApplicationDocument schema v2 与 v1 迁移。
2. `EPIC-002` Studio Core：命令、撤销、选择、剪贴板、自动保存。
3. `EPIC-003` 二维 DashboardEditor 框架与 SceneViewportWidget。
4. `EPIC-004` 三维 SceneEditor 路由与返回上下文。
5. `EPIC-005` 统一变量、过滤和 InteractionFlow 运行时。
6. `EPIC-006` Server SDK、`/api/meta`、可变服务器地址。
7. `EPIC-007` Tauri Host、登录令牌安全存储、本地工作区。
8. `EPIC-008` 应用发布包、版本、原子发布和回滚。
9. `EPIC-009` IdentityProvider、飞书/企业微信登录、账号绑定和设备会话。
10. `EPIC-010` Scene Port、Three.js Adapter、相机/控制器、对象/Mesh/材质 API。
11. `EPIC-011` 分级场景脚本、生命周期、时间线、仿真时钟和扩展权限。
12. `EPIC-012` 设备拆解、AGV、机器人、物流节拍参考实现与性能基准。
13. `EPIC-013` ConverterPlugin、隔离执行、任务中心、缓存和转换器 SDK。
14. `EPIC-014` MapProvider、城市底图、轻量 GIS、GeoAnchor 与二三维定位。
15. `EPIC-015` TopologyDocument、TopologyEditor、TopologyViewportWidget 与统一联动。
16. `EPIC-016` Renderer Port、WebGPURenderer、TSL/Node Material、WebGL 2 兼容与双后端质量门禁。
17. `EPIC-017` RemoteRenderSession、GPU Worker、WebRTC、会话调度和云渲染运维。

实施顺序固定为 001 → 002/010/016 → 003/004 → 005 → 006/009 → 008 → 011/014 → 012/013/015 → M6 生态扩展 → 007/017 最后实施。二维、拓扑、地图和三维能力扩容必须建立在模块边界与统一运行时之后，避免继续向当前 overlay 和 `App.tsx` 堆功能。

## 14. 立即执行的下一步

先完成 M0 的技术设计，不直接大改 UI：

1. 定稿 `ApplicationDocument`、对象 ID、Scene Port、脚本能力、资产引用、迁移和发布边界。
2. 为现有项目保存三个 v1 黄金样本，覆盖纯三维、带看板、带事件。
3. 实现 `/api/meta` 与 `ServerClient`，同时让现有 B/S 行为不变。
4. 制作二维编辑器交互原型，完成画布、图层、属性面板和进入三维四条主路径的可用性测试。
5. 用公开 Scene API 制作一个最小“相机切换 + 设备拆解 + AGV 路径运动”技术样例，验证能力边界后再扩展 API。
6. 建立 WebGPU/WebGL 兼容尖峰：同一场景验证基础材质、拾取、动画、后处理、能力探测和回退，再定 Renderer Port 最小接口。

完成以上六项后再进入 M1，可以避免在 UI 已经铺开后反复修改数据模型和发布协议。
