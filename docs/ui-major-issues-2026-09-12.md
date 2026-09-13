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

## 7. C 线 C1-C8(工业预制体造型细节层)—— ✅ 已实施(2026-09-12 扩量任务)

> 交付报告 2026-09-12 第 3.3 节遗留的 8 项"未实施造型细节",已随"预制体扩量 78→98"任务全部落地。
> 验证:`pnpm exec tsc --noEmit -p .` 通过;`vitest run src/prefabs` 21/21 通过(含 98 全量几何有效性、
> 新变体分型指纹差异、C6 行列联动、C1 分色材质断言);playwright 两轮截图闭环
> `apps/web/test-output/assets-prefab/round1|round2/`(round2 终态:编辑器资源面板 98/98 渲染、
> 管理端 prefab tab 5/5 页翻页、0 控制台错误;closeup/ 为新变体单卡近距离目检 10 张)。

| 条目 | 状态 | 实施摘要 |
|---|---|---|
| C1 person 胶囊人形升级 | ✅ 已实施 | 工装裤(深色)与橡胶靴分色、躯干加荧光黄反光背心(前后片+银灰反光竖条)、安全帽帽壳/帽檐/前檐脊,帽色仍按 subtype(访客白/维修橙/作业安全黄)。 |
| C2 vertical-lift 内部机构 | ✅ 已实施 | 四柱框架 + 四根导轨 + 顶梁提升电机 + 提升平台(挡货护栏)+ 载货 + 后侧配重块与双吊链,替代旧两柱+链条示意。 |
| C3 load-cell 秤台特征 | ✅ 已实施 | 底框 + 四角称重传感器柱 + 金属台面 + 五道防滑纹 + 台下接线盒 + 变送仪表,构成完整秤台语义。 |
| C4 码垛/焊接工具端 | ✅ 已实施 | palletizer 族真空工具升级为宽吸盘板 + 2×3 吸盘阵列 + 两侧导料板;welder 工具加导电嘴 + 环形火花防护罩。 |
| C5 空载 AGV | ✅ 已实施 | carrier/tugger/amr/unit-load 空载态顶面平坦,加二维码导航标志(白底+定位码块)与前向磁带路径条;AGV 不再"凭空背货"。 |
| C6 display 行列联动 | ✅ 已实施 | `display.wall` 定义新增 rows/columns 参数(1-6 行 × 1-10 列),缩略图按 m×n 生成单元拼缝阵列,画幅比取 widthM/heightM,阵列总宽归一;分型键抽取扩展 rows/columns/width/height 数值键。 |
| C7 180°/螺旋连续曲面 | ✅ 已实施 | curve-90/180 改为 RingGeometry 环带输送面 + 机架环带 + 水平面内 torus 弧段护栏(顺带修复旧版弧缘立在竖直平面的取平面错误);spiral 改为双道螺旋管(helixTubeAt,TubeGeometry 沿螺旋线扫掠)+ 辐板 + 上下进出料口。 |
| C8 材质细节层 | ✅ 已实施 | kit 新增三类克制的程序化细节助手:ventDotsAt 散热孔阵(柜体/炉体/除尘器)、stripesAt 黄黑警示条纹(冲压/热处理/龙门立柱)、既有 grilleAt 格栅复用;全部几何实现,零贴图引入。 |

- **同批扩量说明**:20 个新预制体(机床 4/机器人 3/公用工程 4/仪表 4/仓储 2/输送 2/无人机 1)全部按新构建器出图,
  新增文件 `prefabThumbnailModelsProcess2.ts`、`prefabThumbnailModelsLogistics2.ts`,既有构建器只做分型分流。
- **诚实申报**:①round1 截图期间出现 6 条 `NetworkStatusBanner` "Maximum update depth" 控制台错误——
  来自并行会话未跟踪新特性 `src/appStatus/`(非本任务所有权文件,未越权修改),round2 复验 0 错误;
  ②管理端翻页曾跳回模型 tab,系并行会话对 `BuiltInAssetBrowser.tsx` 的在改行为,截图脚本已做 tab 恢复容错;
  ③`robot.palletizer-6` 与 `palletizer-4` 同族共用构建器,缩略图轮廓一致(轴数不改变小样造型),属设计内。
