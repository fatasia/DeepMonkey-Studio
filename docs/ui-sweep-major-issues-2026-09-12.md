# 二维资源库商用化升级·待核实大问题清单(2026-09-12)

> 背景:本次"二维资源库缩略图与卡片商用级"任务中,按"只修小问题、大问题写文档待核实"纪律,
> 以下条目因涉及非本次所有权的组件文件、或需要产品决策,未直接实现,逐条汇总待用户核实。
> 每条含:页面 / 问题描述 / 复现步骤 / 截图路径 / 根因分析 / 建议方案 / 影响面 / 严重级。

## 1. 山海鲸式"多特征标签行"缺失(卡片无法按标签检索)

- **页面**:看板编辑器·资源面板(`DashboardComponentLibrary`)、管理端·资源·二维资源 tab(`BuiltInAssetBrowser`)。
- **问题描述**:山海鲸素材库每张素材卡带 2-4 个特征标签(如"渐变""实时""3D")并依赖多标签检索;
  当前卡片只有分组徽标(编辑器 tooltip / 管理端"二维资源"徽标),无标签行。
- **复现步骤**:打开编辑器资源面板或管理端资源页 2D tab,观察卡片文案区,仅有名称与分组,无标签。
- **截图路径**:`apps/web/test-output/ui-upgrade-2d/manager-2d-dark.png`、`panel-图表-0-dark.png`。
- **根因分析**:标签行需改卡片渲染组件 `DashboardComponentLibrary.tsx` / `BuiltInAssetBrowser.tsx`
  (两者均不在本次任务文件所有权清单内),并需在 `dashboardComponentPresetTypes.ts` 的
  `DashboardComponentPreset` 上新增可选 `tags?: readonly string[]`(合同允许新增可选字段)。
- **建议方案**:① preset 工厂按 family 注入默认标签(如 analysis → ["多系列","渐变","联动"]);
  ② 卡片描述下方渲染 2-3 个小标签胶囊(10.5px,`--surface-2` 底 + `--text-muted` 字);
  ③ 搜索匹配串拼接 tags,获得标签过滤能力。
- **影响面**:2 个组件文件 + 1 个类型文件 + 2 个 CSS;纯增量,不破坏既有行为。
- **严重级**:中(观感增强项,非功能缺陷)。

## 2. 编辑器资源卡片描述文本未在卡片上渲染(仅 tooltip)

- **页面**:看板编辑器·资源面板。
- **问题描述**:任务要求"描述提到 11px 且颜色用 --text-muted",但编辑器卡片 DOM 只渲染名称
  (`<strong>`)与"已添加"徽标,描述仅存在于 `title` 悬浮提示;管理端卡片则有可见描述。
- **复现步骤**:打开编辑器资源面板,任意卡片无描述文字;hover 才能看到描述。
- **截图路径**:`apps/web/test-output/ui-upgrade-2d/panel-图表-0-dark.png`。
- **根因分析**:卡片渲染在 `DashboardComponentLibrary.tsx`(所有权外),本次只能通过共享 CSS
  把 `small` 规则提到 11px/`--text-muted`(对模板条目、空态已生效),无法为组件卡新增 DOM。
- **建议方案**:在 `DashboardComponentLibrary.tsx` 组件卡 `<span>` 内追加
  `<small>{item.description}</small>`,CSS 已就绪(11px/--text-muted/截断省略)。
- **影响面**:1 个 tsx 文件;需同步验证卡片高度(当前 min-height 88px 可容纳一行 11px 描述)。
- **严重级**:中。

## 3. 帆软"同屏主色 ≤3 种"纪律与 family 多彩配色的张力

- **页面**:编辑器资源面板"图表"tab(业务指标 18 项同屏)。
- **问题描述**:帆软官方缩略图规范要求同屏主色不超过 3 种(蓝→青→红黄绿);本次按用户明确
  指定的 family 配色(业务指标=金、分析=青、报表=蓝紫、装饰=多彩)执行,且指标组内语义色
  (告警红/能源绿/质量紫/生产蓝/设备青)同屏会出现 5-6 种色相,与"≤3 种"存在张力。
- **复现步骤**:打开编辑器资源面板图表 tab,滚动业务指标分组,观察瓷砖主色分布。
- **截图路径**:`apps/web/test-output/ui-upgrade-2d/panel-图表-0-dark.png`、`manager-2d-dark.png`。
- **根因分析**:用户原始诉求("颜色单一、不高大上")与帆软克制色纪律方向相反;
  family+语义两级配色是按用户 2026-09-11 任务原文落地的,收敛色相需要产品决策。
- **建议方案**:若要向帆软纪律靠拢:① 语义色仅保留告警红与能源绿,其余并入 family 主色;
  ② 或把语义色饱和度统一降 ~20%、明度统一,色彩"多变但不刺眼"(本次已按统一明度选取)。
- **影响面**:`dashboardComponentPresetFactory.ts` 一处色表,改动成本低。
- **严重级**:低(风格取舍类)。

## 4. 帆软"资源分类四类制 + 在线/本地来源分区"的信息架构差异

- **页面**:编辑器资源面板。
- **问题描述**:帆软组件库为"模板/组件/图片/视频"四类 + "在线资源/本地资源"两来源分区;
  当前为 5 tab(图表/控件/媒体/3D/资源),"上传图片/视频"是媒体 tab 内的两个按钮。
- **复现步骤**:对比帆软组件面板与本编辑器资源面板的 tab/分组结构。
- **截图路径**:`apps/web/test-output/ui-upgrade-2d/editor-library-dark.png`。
- **根因分析**:tab 结构由 `DashboardComponentLibrary.tsx` 的 `LibraryTab` 联合类型决定(所有权外),
  且与 `dashboardWorkspaceModel` 的 `DATA_WIDGET_CATEGORIES` 耦合,调整属信息架构重构。
- **建议方案**:保持现有 5 tab(已对齐"大类清晰"的组织感),仅把"上传图片/视频"按钮组
  视觉升级为来源分区标题("本地资源")下的操作行;如需完全 1:1 帆软结构需产品决策。
- **影响面**:1 个 tsx + 1 个 CSS;中等改动量。
- **严重级**:低(结构差异,不影响可用性)。

## 5. 环境临时态:并行会话语法错误曾阻塞管理端截图(已恢复)

- **页面**:管理端全部页面。
- **问题描述**:第 1 轮截图期间 `src/prefabs/thumbnail/prefabThumbnailModelsLogistics.ts`
  (并行会话新建文件)存在语法错误,vite 全量 transform 失败,管理端渲染
  "STUDIO_RENDER_FAILED"。
- **复现步骤**:已于本轮截图前由并行会话自行修复,当前无法复现。
- **截图路径**:`apps/web/test-output/ui-upgrade-2d/manager-full-dark.png`(第 1 轮,错误浮层)。
- **根因分析**:多会话并行修改同一工作区时的中间态,非本任务产出缺陷。
- **建议方案**:无需处理;建议并行会话各自完成文件后再合并验收。
- **影响面**:无。
- **严重级**:低(已消除的临时态,仅留档)。

## 6. 帆软"主题套件 + 量化徽章"概念(visuals 页 7.6 节对照)

- **页面**:看板编辑器·资源面板 / 管理端·资源(参照 docs/competitor-reference-fanruan-shanhaijing-2026-09-12.md 第 7.6 节)。
- **问题描述**:帆软 visuals 页以"主题套件"(域配色打包,如「苍穹青 2.0」)组织素材,套件封面带量化徽章("50+图表/150+组件/140+图片");经典组件区为横排小卡(= 我们现有资源面板卡片语言,本次升级已对齐)。套件与徽章概念我们尚不存在。
- **复现步骤**:对照 competitor-ref/fanruan-visuals-viewport.png 与 test-output/ui-upgrade-2d/manager-2d-dark.png。
- **根因分析**:套件是"组件集合"聚合层,需预设目录引入套件/主题分组数据结构(如 `presetSuite` 字段或独立套件目录)+聚合计数;资源面板与管理端均为单组件粒度,非本次所有权与任务范围。
- **建议方案**:①先在 `dashboardComponentPresetTypes.ts` 增加可选 `suite?: string` 字段,按 family 天然成套(指标=金/分析=青/报表=蓝紫即三套);②管理端资源页顶部加"主题套件"横排入口,徽章计数按 suite 聚合(`50+图表`式);③套件切换联动 preset 全量换色(需产品决策是否覆盖用户自选色)。
- **影响面**:类型文件+目录工厂+管理端横排区;中等改动,跨 B 线(模板中心)边界。
- **严重级**:低(增强概念,需产品决策优先级)。


---

# 全站 UI/UX/功能遍历·待核实大问题清单(2026-09-12,独立任务)

> 来源:全站遍历(`apps/web/scripts/u120-ui-sweep.mjs`,49 步全部通过;辅以 `u120-probe*.mjs` 定向探针)。
> 截图目录:`apps/web/test-output/ui-sweep-2026-09-12/`。
> 以下条目属"渲染核心 / 令牌体系 / 后端稳定性 / 需产品决策"级别,按纪律**未直接修改代码**,逐条待用户核实。

## S1 三维标注标签(billboard)底板与文字比例失调,近景互相遮挡

- **页面**:三维编辑器(任何含标签场景,实测场景"333"的 12 个设备标签)。
- **问题描述**:标签黑色底板宽度远大于文字,镜头越近越明显,相邻标签底板互相叠压,读感像渲染残影;远景比例接近正常。
- **复现步骤**:管理台 → 场景"333" → 编辑 → 切"三维" → 滚轮推进至设备群近景。
- **截图路径**:`apps/web/test-output/ui-sweep-2026-09-12/34-studio3d-view-menu.png`、`36-studio3d-measure-on.png`、`40-studio3d-clipping.png`(远景对照:`20-dashboard-initial.png`)。
- **根因分析(疑似)**:canvas 绘制的 billboard 底板按世界尺寸/固定像素估算,文字为屏幕空间像素,两者缩放系数不一致;定位需进 viewer 标签绘制层。
- **建议方案**:底板按文本实测宽度 + 固定 padding 与文字同空间缩放;或改用 CSS2D/HTML billboard。
- **影响面**:所有含标签/标注/测量结果的场景标签渲染路径。
- **严重级**:P2(观感缺陷,不影响功能)。
- **已实施(2026-09-12)+ 实测根因更正**:原"疑似根因"不成立——底板与文字本就同画布、同缩放系数;真实根因是**标签画布固定 640×160**,短文本("设备 001"约 230px)在 624px 面板里留约 2/3 空板,叠加"屏幕定高 ~40/50px"的展示策略,近景时 ~200px 宽的空板成片出现,读感即"底板远大于文字 + 互相叠压"。截图中真正的黑色斜四边形"残影"与标签层无关,是 OutlinePass 与 Sprite 的交互缺陷,拆分到下方**追加条目 S1-A**。修复(`apps/web/src/viewer/sceneOverlayVisuals.ts`):
  1. 画布宽度改为按文本实测宽度 + 固定 padding 收缩(224~1024px,16px 步进);标题 40px→52px、描述 26px→34px,同屏幕高度下可读性约翻倍;
  2. 碰撞避让候选框不再复用 `estimatedHeightPx`(其对 authoredSize 做 clamp 且写死 4:1 宽高比),改为按 Sprite 当前 scale 与视空间深度换算的真实投影矩形;相机正后方的标签直接隐藏(原实现会镜像投影回视口中心干扰碰撞)。
- **验证摘要(2026-09-12)**:
  - 截图:修复前 `apps/web/test-output/fix-s1/before-qa-{far,mid,near}.png`、`before-s3-{far,mid,near}.png`(真实场景"333");修复后 `final2-qa-{far,mid,near}.png`(visualQa 夹具,真实应用管线)与 `final2-h12-{far,mid,near}.png`(真实 ViewerEngine + 与场景"333"同构的 12 标签受控场景);前后对比裁剪 `cmp-before-*.png`、细节 `final2-h12-near-zoom.png`。
  - 结论:三距离下底板均紧贴文字(同屏板宽约减半、标题像素高约 ×1.7);12 标签近景 8~9 个可见且两两无叠压,远景按距离优先只显示互不重叠子集(碰撞避让按真实投影盒生效)。
  - 门禁:`pnpm exec tsc --noEmit -p apps/web` 通过;`pnpm exec vitest run src/viewer` 354 通过 / 0 失败 / 1 既有 skip(含 sceneOverlayVisuals、annotationLabelLayout、annotationLabelPresentation、viewerDeviceSignals 用例)。
  - 诚实声明:场景"333"的**修复后**实机截图未能补拍——验证时段管理台被并行会话在途改动阻断(React "Maximum update depth exceeded",与本次标签层改动无关;修复前 10:56 同一脚本可正常进入),以真实 ViewerEngine 的同构 12 标签受控场景等效替代。S1-A 幽灵板不在本次修复范围,近景截图中仍可见。
  - 同族排查:测量标签(`createMeasurementLabel`)文字居中、无单侧留白,不属同族;`estimatedHeightPx` 现仅剩展示(可见性/透明度)消费方;`baseWidth/baseHeight` 无其他读取点;prefab 缩略图/天空盒/场景网格的 CanvasTexture 为静态纹理,非文字 billboard,不属同族。

### S1-A OutlinePass 幽灵板(Sprite 世界空间四边形)——已实施(2026-09-12,根会话)

- **现象**:任意被 `setModelEffects(outline:true)` 命中的模型,其绑定标注旁会出现一块无文字、带透视剪切的黑色平行四边形,随镜头推进放大;多个带轮廓特效的设备同屏时成片出现,即原 S1 截图中"底板互相叠压/渲染残影"观感的主要来源。
- **根因(受控场景实证)**:three.js `OutlinePass` 深度预通道以 `scene.overrideMaterial = depthMaterial` 渲染整个场景;overrideMaterial 会替换 Sprite 的 billboard 着色器,使标签共享的单位四边形按**世界空间**几何光栅化(尺寸 = Sprite 当前 scale,实测 3.13×0.78 世界单位),在深度缓冲留下剪切四边形,再经掩码/边缘合成输出为黑板。开关对照:同一场景仅切换 outline,on→出现、off→消失。
- **复现**:`apps/web/test-output/fix-s1/harness.html`(真实 ViewerEngine,单标注 + 单 outline 特效)→ `harness-effects.png` 出现黑板;对照无特效的 `harness-initial.png` 无黑板。
- **修复建议(归属 `postProcessingRuntime.ts`/three 层,非标签层所有权)**:OutlinePass 深度/掩码通道渲染期间隐藏 Sprite(同其对 Points/Line 的既有豁免),或让标签 Sprite 仅对主相机 layer 可见。严重级 P2;修复后近景观感应再明显改善。
- **实施状态(2026-09-12 根会话)**:`postProcessingRuntime.ts` 构造期包装 OutlinePass 实例的 render——其内部深度/掩码渲染期间临时隐藏场景内可见 Sprite,返回后立即恢复;composer 主通道(RenderPass)不受影响,标签始终正常绘制。首版误把隐藏包在整次 composer.render 外层导致标签从主通道消失,浏览器截图发现后已改为仅包 OutlinePass 内部。实测(`?__visualQa=viewer&effects=on` 轮廓激活):远/近景标签紧凑渲染、零幽灵板、管线 P95 21ms 正常(`apps/web/test-output/fix-s1a-ghost/{far,near-outline-on}.png`);postProcessingRuntime+sceneOverlayVisuals 12/12 测试过。诚实边界:仅 WebGL 后处理栈;WebGPU TSL 栈未见该缺陷(其渲染路径不同),未重复验证。

## S2 全局缺 tabular-nums 数字排版基线

- **页面**:全站(KPI 卡、表格、日志、坐标)。
- **问题描述**:规范要求数字一律 tabular-nums;`styles/base.css` 无全局规则,仅 DashboardAiDraft、AiSampleRunner 等零散组件各自声明。管理台计数、数据中心指标(81 ms / 507)、场景信息(2,016 三角面)是否等宽不可控。
- **复现步骤**:DevTools 检查 body 计算样式;对照 KPI 数字列字符宽度。
- **截图路径**:全局性问题,代表页 `35-data-center.png`、`43-studio3d-environment.png`。
- **根因分析**:令牌体系有颜色/层级令牌,未建数字排版基线。
- **建议方案**:`base.css` 增加全局 `font-variant-numeric: tabular-nums`(body 或工具类),全站生效需设计侧拍板。
- **影响面**:全站数字渲染,需一轮排版回归。
- **严重级**:P3(规范落地项)。
- **已实施(部分,2026-09-12 样式治理会话)**:按"定向选择器、禁止 `* {}` 全局规则、全局 body 方案待设计拍板"的边界,8 个文件约 35 个选择器补齐 `font-variant-numeric: tabular-nums`:
  - `styles/platform-components.css`:`.dashboard-value`(容器,数值/单位继承)+ 同族看板数值组件(`.dashboard-progress-widget header strong`、`.dashboard-rank-widget b`、`.dashboard-status strong`)、优化器 KPI(`.optimizer-statistics strong`、`.optimizer-bake-result strong`)、7 个滑杆 `output`;
  - `styles/dashboard-workspace.css`:运行状态/缩放/刷新间隔 `output`、报表表格 `td`/行号/合计、数字翻牌、液位数值、滚动表格数据、控制器计数徽章、模板计数、运行页页码共 12 选择器;
  - `styles/platform-pages.css`(系统日志表 `td`/日志计数/审计表 `td`)、`centers.css`(what-if/维护风险/电池 KPI、运行指标徽章)、`resourceGovernance.css`(治理 KPI、用量徽章)、`scene-manager.css`(场景计数)、`operations-study.css`(物流指标表)。
  - 既有零散声明(sceneInspectorControls、smart-asset-binding、unified-asset-library、managerDirectoryStatus 等)未重复添加。
- **遗留清单**:① 全局(body 级)基线仍需设计拍板;② 并行会话所有权文件(dashboardComponentLibrary.css、DashboardTemplate* 等)内数字类待其会话自查;③ `.dashboard-drill-chart>nav small` 等纯文本小字未加(非数字语义)。

## S3 z-index 裸值面广,与 --layer-* 令牌并存(含 999990/999999)

- **页面**:全局(42 个 CSS 文件)。
- **问题描述**:已定义 `--layer-workspace/modal/toast`,但存在大量裸值(1/2/…/60/80/120/135/140/999989/999990/999999),如 dashboard 画布选框/参考线用 999989~999999。多为局部 stacking context 内相对有序,但无分层表约束,后续叠加易再现"遮挡按钮"类缺陷(本次 S4 即此类)。
- **复现步骤**:`grep -rn "z-index" apps/web/src --include=*.css | grep -v "var(--layer"`。
- **截图路径**:无(代码级)。
- **根因分析**:z 层未令牌化;画布内 9998xx 属局部约定。
- **建议方案**:画布内局部层级建立 `--z-canvas-*` 约定;全局弹层收敛 --layer-*;新代码禁裸值。全局治理建议单独排期,不宜随手改(相对次序易被打碎)。
- **影响面**:全部浮层。
- **严重级**:P3(治理项)。
- **已实施(2026-09-12 两轮样式治理会话,限 styles/ 目录;第二轮已获批准继续收敛)**:
  - **层级总表落地(base.css)**:全局浮层按语义分带并写入 base.css 权威注释——页面内容 0–14(组件内局部,不设全局令牌)→ 浮动面板 20 `--layer-panel` → 下拉/弹出 40 `--layer-dropdown`(与 `--layer-workspace` 40 同值带:顶栏内弹出层锚定其上)→ 模态遮罩 60 `--layer-backdrop` → 对话框/右键菜单 80 `--layer-dialog` → 全屏运行时 120 `--layer-runtime` → 文档级模态 200 `--layer-modal` → toast 240 `--layer-toast` → 画布特殊层 999989–999999 `--layer-canvas-*`。**新增令牌 5 个**:`--layer-panel/dropdown/backdrop/dialog/runtime`;铁律写入注释:任何两处相对次序不得因令牌化反转,带内上层用 `calc(var(--layer-*) + N)` 保持精确值。
  - **第一轮已收敛 5 处**:behavior-split 顶栏 40 → `var(--layer-workspace)`×2;病理值 999990/999989/999999 → `--layer-canvas-guide/canvas-smart-guide/canvas-selection`。**≥1000 病理裸值清零**。
  - **第二轮收敛 39 处(全部值不变、相对次序不变)**:模板库遮罩 60→`--layer-backdrop` + 右键菜单 80→`--layer-dialog`(成对);运行时族 120/135/140/142→`--layer-runtime`/calc(+15/+20/+22);3D viewer 面板族 20/21/22/23→panel 带及 calc;XR/物理面板 20→panel、HUD 30→calc(+10);场景树右键菜单 100→calc(dialog+20)、行菜单 40→dropdown;智能绑定遮罩 82→calc(dialog+2)、设备布局遮罩 80→dialog;optimizer-loading 50→calc(workspace+10);credits 遮罩 40→dropdown(轻遮罩语义);管理台下拉族 20/30/50→panel/calc;AI 助手面板 32→calc(panel+12)、平台浮窗 120→runtime;行为面板族 35/36/70/40→calc/var;其余小计见各文件行内注释。
  - **记录保留 54 处 + 并行会话值 1 处**:①页面内容带 0–14 共 51 处(粘性表头/卡片徽标/节点把手/冻结列族等,均为组件 stacking context 内局部相对值,无全局语义可映射,映射反而有跨组件抬升风险),逐处加 `/* z-index-audit: keep */` 注释;②精调值 3 处:behavior 工作台槽位 34×2(面板带 20 与顶栏 40 之间成对同值)、workspace-recovery-backdrop 180(介于运行时带与 --layer-modal 200 之间,升至 200 会改变文档级模态 tie-break)、相机视角浮板 17(低于同区菜单 24);③`scene-workspace.css` `.environment-control` z-index:20 为并行会话 S4 修复值,本次不动(值恰为面板带基线)。
  - **排除文件(并行会话所有权,只记录不动)**:dashboardComponentPreview.css 22 处、DashboardTemplatePreview/Library 与 templateSampleData 相关、app-network-status.css(已合规,`var(--layer-toast, 9000)` 回退值永不生效)。
  - **回归抽查(fix-s3-final,Playwright,admin)**:10 项清单 before/after 各一轮(`apps/web/test-output/fix-s3-final/`,探针 `scripts/fix-s3-final-probe.mjs`)——①管理台场景卡更多菜单+项目管理菜单 ②模板库弹窗+backdrop(深浅双主题)③3D 编辑器更多弹层/导出子菜单/资源浮窗 ④看板节点右键菜单 ⑤网络降级横幅(503 注入,深浅双主题)。逐对像素 diff:8 项 0%~0.001%,2 项 0.448%/0.125% 经人工复核均为动态内容(模板封面异步渲染、画布组件自动保存累积),**无浮层被盖/盖错回归**;深浅主题各抽 2 项通过。CSS 括号平衡 37 文件全过;vitest `src/components` 1193/1193、`src/styles` 16/16 通过。
  - 遗留:排除文件内 22 处裸值待并行会话按同一层级总表收敛;新代码一律用 `--layer-*`,禁裸值。

## S4 (已小修,请复核)三维环境面板关闭按钮被视图立方体遮挡

- **页面**:三维编辑器·查看与分析 → 环境与灯光。
- **问题描述**:场景环境面板右上角 X("关闭环境与灯光")被视图立方体(`.view-orientation-cube`,top:70 right:16,z-index:10)压住:视觉不可见、真实鼠标点击无法命中(elementFromPoint 命中 `BUTTON.cube-face`,点击重试 30s 超时)。
- **本次处置**:属"透明元素遮挡按钮 = P1 红线"且修复局部,已直接将 `.environment-control` z-index 2 → 20(styles/scene-workspace.css,对齐同文件 `.physics-panel` 先例)。修复后真实鼠标点击 X 成功关闭面板;同族排查:剖切栏(居中不重叠)、物理面板(z 20)无此问题。
- **请核实**:面板展开时右上角会盖住立方体左下角(浮层高于导航辅件,Unity/ThingJS 同类行为)。若要求"立方体永在最上",应改为面板默认位置下移,属产品取舍。
- **截图路径**:`probe-101-env-panel-open.png`(修复前)、`probe-crop-envheader.png`、`probe-fix-env-closed.png`(修复后)。
- **根因分析**:两浮层默认位置重叠且层级倒挂。
- **影响面**:环境面板、视图立方体的层叠关系。
- **严重级**:P1(功能入口被遮挡),已修复待复核。

## S5 遍历期间后端瞬时不可用:整批 /api/projects/* 502 + WebSocket 断连

- **页面**:三维编辑器(波及所有依赖项目 API 的页面)。
- **问题描述**:一轮遍历中途 1~2 分钟内 `/api/projects/<id>`、`/api/projects/<id>/vision/events` 连续 502,数据 WebSocket 反复断连重试(该轮记录 42 条 console error、36 条 HTTP 失败);期间三维模式切换按钮因场景数据不可用禁用,无"连接中断"用户提示。恢复后功能正常,后续多轮未复现。
- **复现步骤**:未能稳定复现;当时多会话并发运行,疑似 dev API 并发承载不足或单接口抛错。
- **截图路径**:无(错误样本见最终交付报告控制台汇总)。
- **根因分析(疑似)**:dev API 并发承载/异常兜底不足;前端缺数据连接断开的全局提示。
- **建议方案**:后端排查 502 时段日志;前端加"数据连接已断开,自动重连中"状态条。
- **影响面**:三维编辑器、看板数据在线状态、全部项目 API 页面。
- **严重级**:P1~P2(视后端结论)。
- **实施状态(2026-09-12 前端部分已实施)**:新增应用级连接状态监控与横幅——`src/appStatus/networkStatusMonitor.ts`(状态机 idle→degraded→recovered,连续 ≥2 次 5xx/网络错误触发;4xx 视为链路健康;恢复后提示 4s 自动收起)、`src/appStatus/NetworkStatusBanner.tsx` + `styles/app-network-status.css`(顶部居中,role="status",不阻塞操作)、在 `api.ts` 在线 fetch 出口统一接线。浏览器实测(Playwright 路由拦截 503):降级横幅出现文案正确、放行后"连接已恢复"自动收起(`apps/web/test-output/fix-s5s6s8/s5-*.png`)。**后端 502 排查仍待后端处理**;WebSocket 断连当前仅影响其自身功能,主链路由 fetch 监控兜底。单元测试 6/6(`networkStatusMonitor.test.ts`)。

## S6 自动保存出现 409 Conflict,未见面向用户的冲突提示

- **页面**:看板编辑器(波及三个工作区的自动保存)。
- **问题描述**:遍历中一次 `…/applications/<id>` 保存返回 409,页面继续可用,但无 toast/对话框告知冲突及处理结果。项目当时正被多会话并行编辑,冲突大概率由此产生。
- **复现步骤**:多会话并行编辑同一应用文档并触发自动保存(条件性复现)。
- **截图路径**:无(下一帧截图无可见提示)。
- **根因分析(疑似)**:应用文档有修订保护,但 409 分支的 UI 反馈链路缺失或被吞。
- **建议方案**:补冲突分支 UI(提示他人在编辑,提供重载/另存动作),核对所有 409 路径都有 UI 出口;协作语义需产品决策。
- **影响面**:三维/看板/脚本工作区自动保存。
- **严重级**:P2。
- **实施状态(2026-09-12 已实施)**:核查发现场景保存链路(`scenePersistenceController`)**已有**冲突指引(`workspaceSaveFailureGuidance`:明确文案+服务器版本号+暂停自动保存+不覆盖服务器);真正的缺口在**应用(2D)文档保存路径**——`applicationRuntimeController.saveActiveApplication` 此前只走通用 5 秒错误提示且不暂停自动保存,冲突会反复出现。已复用同一指引函数接入(同族修复):409 时展示完整冲突指引并暂停自动保存。浏览器实测(Playwright 拦截保存接口返回 409 + 制造脏状态):指引 toast 完整可见(`apps/web/test-output/fix-s5s6s8/s6-conflict-guidance.png`)。协作语义(他人实时编辑提示)仍属产品决策,未实施。

## S7 低于 11px 的小字号散点(密度取舍,需设计拍板)

- **页面**:看板画布标尺、资源卡徽标、面板眉题。
- **问题描述**:看板标尺刻度 6px(`.dashboard-ruler span`,dashboard-workspace.css)、环境面板眉题配套 small 8px(疑似死规则)、部分徽标 10px,低于"字号 <11px"红线。
- **复现步骤**:看板画布顶部标尺放大观察;资源卡"已校验"徽标。
- **截图路径**:`31-dashboard-after-drop.png`(标尺)、`47-assets-default.png`(徽标)。
- **根因分析**:仪表密度路线与 UI 红线的边界决策。
- **建议方案**:标尺刻度提至 9px(设计工具惯例)、徽标提至 10~11px,设计确认后统一改。
- **影响面**:看板标尺、资源卡徽标、面板眉题。
- **严重级**:P3。
- **已实施(标尺项,2026-09-12 样式治理会话)**:`dashboard-workspace.css` `.dashboard-ruler span` 6px → 10px(Consolas 等宽,含 `font` 简写重申);密度治理:标尺 DOM 刻度本就全为主刻度(`DashboardRuler.tsx` majorStep 随缩放 100/200/500 自适应,无次刻度),新增 `.dashboard-ruler span:nth-child(even) { color: transparent }` 令偶数刻度"留线去字",读数间隔 ≥2×step×zoom ≥100px,10px 等宽 4 位数约 24px,无重叠;刻度线为 span border 不受影响,`pointer-events:none` 维持,拖参考线/交互行为不变。**实测说明**:computed 字号为 12px——`accessibilityReadability.css` 第 56 行"工作台可读性基线"(`font-size:12px !important`,标尺不在 `.dashboard-artboard` 豁免范围)接管了字号,高于本条 10px 声明且同样达标(该文件首行注释允许技术标尺用 10px);`dashboardWorkspacePolish.css` 早已把标尺放大到 24px 高,12px 数字与 24px 标尺协调,特写截图可读性良好。深浅主题与 computed 断言(4/4 通过):`apps/web/test-output/fix-s2s3s7/`(before / after-r1 / after-r2,含模板库弹层、3D 编辑器、管理台浅色层叠抽查,console error=0)。
- **遗留清单**:① 场景卡"已发布"徽标 8px(`scene-manager.css` `.scene-published-badge`);② 资源卡徽标 10px(dashboardComponentLibrary.css,并行会话所有权);③ 环境面板眉题配套 small 8px(疑似死规则,scene-environment 系)。均待设计拍板后统一提级。

## S8 (产品语义确认)场景卡"编辑"默认落在二维工作区

- **页面**:管理台场景卡。
- **问题描述**:"编辑场景"进入工作区默认二维模式,对以三维内容为主的场景首次动线多一步(空态文案表明默认二维是有意设计,但对既有三维场景是否应默认三维需确认)。
- **复现步骤**:管理台 → 任意场景卡 → 铅笔。
- **截图路径**:`20-dashboard-initial.png`。
- **根因分析**:工作区默认/记忆模式的策略待定。
- **建议方案**:按场景主内容类型或记住上次模式,需产品确认。
- **影响面**:管理台全部场景卡入口。
- **严重级**:P3(动线优化)。
- **实施状态(2026-09-12 已实施,采用"记住上次模式"方案)**:新增 `src/studio/lastWorkspacePreference.ts`(按项目 id 记忆上次工作区,localStorage 读写失败静默降级);`useAppRuntimeEffects` 在进入 studio/dashboard 时写入记忆;`openSceneDashboard`("编辑场景"入口)读取记忆——上次在三维则直达三维编辑,无记录保持默认二维(新项目行为不变)。浏览器实测:默认落二维 ✓ → 看板切三维 ✓ → 回列表再点"编辑场景"落三维 ✓(`apps/web/test-output/fix-s5s6s8/s8-remembered-studio.png`,顶栏"三维"激活)。按场景主内容类型自动判断的方案未实施(需产品定义"主内容类型")。

---

## 8. B 线(看板模板中心)B1 封面重绘 + B2 结构改造 + 扩量 30 域/300 模板 —— ✅ 已实施(2026-09-12)

> 对标规格:`docs/competitor-reference-fanruan-shanhaijing-2026-09-12.md` 第 3/4/5/6.2/7.1/7.4/7.6 节。
> 对标语言:山海鲸模板市场(近黑底、域色渐变封面、主视觉居中+图表环绕、金色分层角标、推荐/最新双分区、
> 特征标签)+ 帆软模板市场(行业分组+类型筛选)+ 帆软 visuals 页(主题套件聚合层+量化徽章)。
> 版权红线:全部封面为程序化自绘 SVG,未下载/引用竞品图片;套件命名(鎏金/绛霄/翠涛/青冥/沧澜/紫电/霞光)原创。

### 8.1 B1 封面重绘(300 个封面全部数据驱动生成)

- **机制保持**:封面仍由 `buildDashboardTemplateNodes` 真实版式 frame 驱动(封面即插入版式)。
- **渲染升级**(`dashboardTemplateCoverArt.tsx` 新建,14 种净化图形):域 surface→更深渐变底 + 细网格纹理
  (径向 mask 渐隐,山海鲸地面网格语言)+ 顶部微高光线 + 域 accent 角部光晕;主视觉块按真实组件类型绘制
  净化图形本体(无轴线/无图例/无背景横线:平滑曲线/渐变柱/环形/仪表弧/雷达/桑基/树图/地图飞线/漏斗/旭日/散点);
  KPI 卡 = 大数字 tabular-nums + 涨跌箭头 + 真实指标名与单位,按 metricTypes 差异化(翻牌格/进度条/状态点);
  明细区 = 行抽象(序号圆/名称条+数值),标题条 = FVS 式左色条+浅色大字+渐隐线。
- **诚实边界**:封面示意数字为确定性伪随机装饰(coverRandom,同模板恒定),插入组件仍为空数据待绑定
  (`DashboardTemplatePreview.test.tsx` 断言渲染确定性);特征标签 3-4 个全部由布局结构推导
  (主图/次图/明细形态/状态告警能力),`DashboardTemplateCatalog.test.ts` 断言可追溯。
- **双主题**:封面内部为"深色大屏孤岛"(恒深底 + #eaeaea 级固定浅色文字,对比 ≥4.5:1),卡片容器随主题。

### 8.2 B2 模板中心结构

- **行业分组下拉**:30 域归并为 9 个语义大类(生产制造/能源环保/物流仓储/经营管理/安全质量/园区建筑/水处理/公共服务/新兴领域),映射集中于 `dashboardTemplateGroups.ts`。
- **类型筛选**:全部类型(推荐+最新双分区)/ 推荐(行业包优先+标签数内容完整度排序,不造假热度)/ 行业包 / 我的收藏。
- **双分区**:『推荐』横排滚动行(8 张)+『最新』全量网格(目录定义顺序),山海鲸式分区标题+说明。
- **卡片信息结构**:封面(左上 tier 徽章:行业包=金色/标准=中性)→ 标题 14px/600 → 行业标签 → 描述 12px --text-muted → 特征标签 11px 胶囊行 → 收藏/插入;hover 主色描边(既有)。
- **搜索联动 tags**:标题/行业/目标/描述/指标/特征标签全量匹配。
- **主题套件层**(对标帆软 visuals 套件,内容原创):`dashboardTemplateSuites.ts` 按域色相族把 30 域组成 7 套
  (鎏金/绛霄/翠涛/青冥/沧澜/紫电/霞光),`DashboardTemplateDefinition.suite` 可选字段;模板库顶部横排套件入口卡
  (套件色渐变底 + 描述 + 量化徽章"N 模板 · M 类主图表",由目录真实统计),点击过滤 + 退出按钮,双分区随套件内数据自然收缩。
- **资源页模板分支**:徽章保留行业分类(右上),tier 徽章由封面左上角展示;新增特征标签行与搜索联动(`BuiltInAssetBrowser.tsx` 仅模板分支,prefab 分支未动)。

### 8.3 扩量 12 → 30 域(120 → 300 模板)

- **第一批 +8**(`dashboardTemplateDomainPacksExtended.ts`):医疗健康(青蓝 201°)、政务党建(正红 357°)、
  零售电商(橘红 10°)、金融服务(钢蓝 219°)、通信运营(蓝紫 272°)、交通枢纽(信号橙 24°)、文化旅游(紫红 315°)、农业农村(草绿 95°)。
- **第二批 +10**(`dashboardTemplateDomainPacksExpanded.ts`):电力电网(电光青 182°)、石油化工(橄榄绿 112°)、
  汽车制造(低饱和钢蓝 214°/S32%)、半导体(紫晶 285°)、医药制造(玫红 340°)、餐饮零售(亮橙 16°)、
  房地产建筑(蓝紫 243°)、环保监测(环保绿 145°)、教育培训(明黄 55°)、文娱体育(品红 330°)。
- 每域 10 项中英双语+单位行业真实指标(医院的床位候诊、政务的办件量满意率、半导体的良率洁净度等),结构完全复用既有工厂;
  accent/surface 走 30 域色环空隙分配,近邻靠色相偏移+明度饱和差+surface 冷暖三重区分(各域注释可查)。

### 8.4 验证证据(2026-09-12)

- `pnpm exec tsc --noEmit -p .`(apps/web)通过(0 错误)。
- `pnpm exec vitest run`模板相关 7 文件 343/343 通过(含 300 模板逐个建节点用例、300/30/9 组/7 套件断言、
  行业包 tier 断言、标签可追溯断言、封面确定性断言)。
- playwright 视觉闭环 4 轮(`apps/web/test-output/assets-template/round1|round2|round3|round4/`):
  - round1 发现 P1:推荐/最新分区重叠(面板为三行 grid,双分区 4 子元素破坏行模板)→ 内容统一收进
    `.dashboard-template-body` 滚动容器;横滚行卡片连排 → row 卡补 flex column;筛选两列 → 三列覆盖。
  - round2 复验:分区正常、300 卡网格正常、4 新域插入渲染正确,0 控制台错误。
  - round3:30 域/300 模板 + 套件行 + 套件过滤 + 6 新域插入(医疗/政务/金融/文旅/电力/半导体)+ 双主题全量复验;
    再修 3 个 P3:row 卡行业小字在标题上方(order 规则只写了 grid 选择器)、row 预览定高被 Preview.css 同特异性
    源顺序压制、row 卡收藏星标未绝对定位(定位规则同样只写 grid 选择器)——同族根因均为
    `styles/dashboard-workspace.css` 的 grid 卡选择器未覆盖新 row 容器,均在自有 CSS 内补齐。
  - round4 终态:双主题 + 9 分组封面抽样 + 套件交互 + 6 新域插入,0 控制台错误。
  - 说明:插入验证页(visualQa)初始自带 9 个示例组件,故插入后画布为"示例+模板"共 18 组件;个别轮次
    reload 未生效导致前后两组模板叠加(27 组件),属验证脚本现象,模板组件本身渲染与属性正确(顶层级)。
- **同族清剿附带修复**:全仓 18 处 `./DashboardTemplateCatalog` import 与磁盘真实文件名
  `dashboardTemplateCatalog.ts` 的 casing 不一致(TS1149/TS1261,Windows forceConsistentCasingInFileNames),
  统一改为与磁盘一致;该问题在本次改动前已存在于程序中(上一轮 tsc 通过的记录与现状矛盾,以现状实测为准)。
- **诚实申报**:①封面示意数字是装饰,业务数值需插入后绑定数据;②推荐排序键=行业包优先+特征标签数(布局
  组件丰富度),不虚构浏览量/热度;③parallel 会话期间管理端资源页徽章样式文件(`styles/unified-asset-library.css`)
  属禁改目录,资源页徽章沿用既有样式仅换文案。
