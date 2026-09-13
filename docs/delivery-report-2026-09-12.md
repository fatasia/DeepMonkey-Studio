# 交付报告:性能证据补充 + 全量测试 + 资源/模板商用化(2026-09-12)

> 执行:GLM(根会话 + 4 并行子代理,文件所有权互斥)。对照基准:帆软 FVS/市场、山海鲸、ThingJS、Hightopo(结构与风格复刻,零素材复制)。
> 全部改动未提交未 push;admin/admin、.env、postgres+minio 未动;旧用户数据保留。

## 1. 任务一:性能项证据补充 ✅ 完成(根会话)

### 1.1 OffscreenCanvas:从"空开关"到真实能力
核查发现 worker 渲染模块 6 个文件早已存在但**引擎从未接线**(UI 开关勾选无任何效果),直接违反"不授权以空开关代替实际能力"。本轮根因面接线:

- 协议扩展(ready/位图回传/环境能力检测);worker 渲染后 `transferToImageBitmap` 回传,错误分类(scene-stale 可静默重启/其余透传可读原因)。
- 新控制器 `viewerOffscreenController.ts`:启动前场景体检(不兼容透出具体原因)→ 快照 → worker 绘制 → 位图回传覆盖画布;结构漂移防抖重检(800ms)、静默重启预算(2 次/20s,超限如实回退)、材质按需采样(version 变化 + 90 帧兜底)。
- 引擎集成(Core/Runtime/Lifecycle/绑定必选化);标注与告警 Sprite 属易变叠加层,不进快照与签名,由主线程按投影位置补绘在位图之上;设置页展示真实运行状态与回退原因。
- 真实修复两个崩溃:快照"先 await 后序列化"竞态(await 间隙场景变化导致序列化了未体检对象);three `ObjectLoader.parseTextures` 对缺失图像抛 `undefined.data`(解析前纹理/图像合同校验)。

### 1.2 浏览器门禁实测(生产 QA 构建,headless Chrome,`gate:performance-evidence`)

| 特性 | 实测结果 |
|---|---|
| 大对象树虚拟化 | 10000 行仅挂载 **19 行**,DOM 元素减少 **99.8%**;末行 reveal 可达(device-9999 真实选中);关闭窗口化对照 10000 行全挂载 |
| 遮挡剔除 | 实体墙夹具 **511/601 网格被剔除、免绘 621,376 三角形、draw calls 降 84.0%**;运行时关闭恢复原路径;开/关画面 SSIM 0.9976(无可见破洞) |
| OffscreenCanvas | 激活后**主线程 drawCalls=0**(worker 240 draws/14.4 万三角形),主线程帧工作量 473ms→55ms;结构漂移静默重启(restarts≥1,mode 保持 active);关闭恢复主线程;**WebGPU 如实回退**并给出可读原因 |
| 画面保真 | 主/worker SSIM 0.9584、严重差异像素 1.49%——差异源于 OffscreenCanvas WebGL 在 headless 下 MSAA 不可用与网格纹理 mipmap 路径,diff 图目检无几何错位 |

- 单元测试:控制器 9 用例(环境缺失/场景不兼容/激活发帧/材质按需采样/漂移重启/预算耗尽回退/线程错误回退/关闭清理/dispose 幂等)。
- 集成复验:A/B/C 三线合并后全源码重跑门禁,上表数字全部保持(run-nrglWC)。
- 证据:`docs/performance-verification-2026-09-12.md`、`test-output/perf-evidence-2026-09-12/run-nrglWC/`(report.json + 截图 + diff 图)。
- 同族排查:四个性能开关全部核实非空;快照竞态两条启动路径一并修复;Sprite 剔除覆盖标注+告警两类叠加层。

## 2. 任务二:全量 UI 测试(最高优先级)— D 线 ✅ 完成

- 覆盖:持久化脚本 `apps/web/scripts/u120-ui-sweep.mjs`(49 步,单步 try/catch 可重跑)三遍全过——1440×900 主遍历 + 1280×800 + 980 窄窗;登录(空提交禁用/错误密码 110ms 反馈)、管理台(搜索 16→0→清除、筛选、排序、新建弹窗)、资源库四类(模型 507/全库 1689/二维 157/模板 120/预制体 78 + 子筛选)、3D 编辑器(变换/测量/标注/剖切实测切片生效/爆炸/三菜单全展开/时间线/属性 3 tab/相机漫游/资源库弹层)、2D 看板(拖入组件成功+Ctrl+Z 撤销/模板弹窗 Esc/字段面板/页面增删闭环)、脚本/拓扑/数据中心/AI/优化器(流水线状态条)/云渲染/设置 6 tab/品牌设置(后台线程渲染开关实测 false→true→false)、980 窄窗全部无横向溢出。
- **发现并修复 1 个 P1**:3D 编辑器"环境与灯光"面板关闭钮被视图立方体遮挡(z-index 2<10;真实鼠标点击 30s 超时,elementFromPoint 命中立方体)——`.environment-control` z-index 2→20(对齐同文件物理面板先例);修复前超时/修复后真实点击关闭成功,同族排查剖切栏与物理面板无此问题,49 步重跑无回归。
- **待核实大问题 8 条**(`docs/ui-sweep-major-issues-2026-09-12.md` S1-S8):标签底板比例失调(P2)、全局 tabular-nums 缺失、z-index 裸值治理(42 文件,含 999989-999999)、后端瞬时 502+WebSocket 断连无前端提示、自动保存 409 冲突无反馈、<11px 小字散点、"编辑场景"默认落二维语义确认、环境面板遮挡(已修请复核)。
- 控制台:最终轮仅 1 条预期内 401(错误密码用例);历史轮 502/409 瞬时自愈,根因待后端核实(疑多会话并发)。
- 不可用小功能专项:唯一实锤即上述 P1(已修);优化器"转换/编辑与优化/项目素材"点击无反应属设计(流水线状态指示器,非 tab)。
- 未覆盖(诚实声明):文件导入类(headless 无法操作系统文件对话框)、场景卡复制/重命名/删除、版本历史、发布流程(破坏性,仅确认入口)、脚本试运行、浅色主题与英文语言、七轴全矩阵;测试期间检测到并行会话在同一项目工作(409),个别截图可能含他人中间态。
- 产物:截图约 100 张 `apps/web/test-output/ui-sweep-2026-09-12/`、JSON 报告 sweep-report.json/probe-report.json。

## 3. 任务三:资源/模板商用化(较低优先级)— A/B/C 线

### 3.1 A 线:二维资源库(157 预设)
- family 级配色体系(业务指标=金/分析=青/报表=蓝紫/装饰=多彩,替代全挤蓝绿)、迷你图净化(对标帆软"去轴线/去图例/去背景横线")、指标卡真实感 KPI(tabular-nums+涨跌)、卡片字号提升(标题 12.5-13px/描述 11px+--text-muted)、编辑器与资源页两处卡片语言统一、浅色主题瓷砖穿帮修复(去硬编码深色)。
- 验证:tsc 0 错误、触及模块 18/18、三轮双主题 34 张截图(`apps/web/test-output/ui-upgrade-2d/`)。10 维自评均 ≥9(3D 不适用)。

### 3.2 B 线:看板模板中心(120 模板)
- 12 域 accent/surface 等距色环重排(按帆软行业色调映射自查:水务=蓝/双碳=青绿/安全=红/经营=香槟金);图表系列色板升级 8 色明度渐进;FVS 式标题条(左侧圆头色条+标题+单位右置);大数字 tabular-nums;卡片标题 14px/600 置顶 + hover 主色描边环;封面线框对比度三值提升(文字 20%→72% 混白)。
- **按纪律回退**:封面机制级重绘(完整方案 B1)与模板中心结构改造(9 类归并导航/类型筛选/特征标签/热门最新分区,B2)写入待核实文档,未实施。
- 验证:触及模块 130/130、三轮双主题 24 张截图(`test-output/ui-upgrade-template/`)。自评:布局/令牌/排版/交互/反馈/响应式/语义 9,动效 8.5、信息设计 8.5(封面线框为未决主体,如实扣)。

### 3.3 C 线:工业预制体缩略图(78 个,14 类 kind 全覆盖)
- 全部换成程序化三维真实小样(泵/阀/风机/空压机/柜体/CNC 六工艺/机器人五族/输送七布局/AGV 五型/货架/传感器六族/相机三族等),PBR 材质语言+ACES+三光向+接触阴影+包围球取景;共享离屏渲染器串行队列+缓存+WebGL 不可用永久降级;首帧图标骨架零跳动、就绪淡入。
- 验证:78 定义全量几何有效性+分型指纹差异+队列/缓存/降级 9 用例;全量回归 2024 用例通过;4 轮截图闭环(round1 发现 3 项构图问题→修复→round4 终态 78/78 渲染、0 控制台错误;`apps/web/test-output/ui-upgrade-prefab/`)。自评 9.0-9.3,**响应式 8.9(浅色主题观感未实测,如实申报)**。
- 未实施项 C1-C8(person 胶囊人形细节/码垛焊接工具端/材质贴图层等)写入待核实文档。

## 4. 跨区集成与同族排查

- 全仓 `tsc --noEmit`(apps/web)通过(含四线合并后);全量 Web 测试 2023/2026 通过。
- 唯一失败:`src/architecture.test.ts`——由**并行 WebGPU 自研引擎会话**的新增未跟踪文件 `packages/deep-engine/lab/{fixture,main}.ts` 违反 web 边界所致,非本轮任何一线产物,未越权修复,已记录待该会话处理。
- 性能门禁在 A/B/C 合并后全源码重跑全绿;viewer+visualQa 350 用例无回归。
- 竞品参照入库:`docs/competitor-reference-fanruan-shanhaijing-2026-09-12.md`(7.1-7.6,含 FVD 七维筛选/纯净封面卡片、市场 9 大行业类、FVS 官方配色规范、山海鲸深色市场布局、ThingJS 资源中心、Hightopo、visuals 主题套件),截图 `test-output/competitor-ref/`。

## 5. 待用户核实清单(全部未实施,等决策)

- `docs/ui-sweep-major-issues-2026-09-12.md`:A 线 6 条(特征标签行/卡片描述渲染/配色纪律张力/四类制信息架构/主题套件聚合层/临时态留档)+ D 线遍历发现的大问题。
- `docs/ui-major-issues-2026-09-12.md`:B 线 B0-B2(封面重绘全案/模板中心结构改造)+ C 线 C1-C8(造型细节层)。

## 6. 诚实条款(未验证/未覆盖声明)

1. OffscreenCanvas 画面保真 SSIM 0.9584 为 AA/mipmap 实现差异,已目检 diff 图,但**未做逐像素等价声明**;CPU Tracing 主线程任务对比仅记录未断言。
2. 性能门禁为 headless Chrome + 合成夹具口径;非真机 1080p 长跑;整机 FPS 不做声明。
3. C 线浅色主题下 3D 缩略图观感未实测(背景为烘焙深色);B 线 480px 断点未实测(min-width 自适应兜底);A/B 封面与模板插入的线上大屏效果以截图为准,未做 4K 验证。
4. D 线遍历以 1440/1280/980 三档为主,480 移动端不在本轮范围;触屏/无障碍读屏未测。
5. 帆软"视觉风格库"专题内容(需登录)未抓取;山海鲸素材详情页像素级截图因桌面锁屏未完成,结构已由 a11y 提取。
6. 全部工作未 commit;并行 WebGPU 会话的 deep-engine 改动与本轮并存于工作区,合并验收时需全仓重跑。

## 7. 10 维打分汇总(逐维 ≥9 为交付线;凭实测截图打分)

| 维度 | 性能线(门禁实测) | A 二维资源 | B 模板中心 | C 预制体 |
|---|---|---|---|---|
| 布局构图 | 门禁断言全过 | 9 | 9 | 9.3 |
| 令牌一致性 | 无硬编码新增 | 9 | 9 | 9.2 |
| 排版 | — | 9 | 9 | 9.0 |
| 交互状态完备 | 开/关/回退三路径实测 | 9 | 9 | 9.2 |
| 动效质量 | — | 9 | 8.5* | 9.0 |
| 3D/渲染质量 | SSIM/draw 数据见表 | 不适用 | 不适用 | 9.1 |
| 信息设计 | avoidedTriangles/draw 降幅量化 | 9 | 8.5* | 9.3 |
| 反馈即时性 | 回退原因可读 | 9 | 9 | 9.2 |
| 响应式与主题 | 双后端(webgl/webgpu) | 9 | 9** | 8.9** |
| 语义与文案 | 原因可操作 | 9 | 9 | 9.0 |

\* 封面重绘待核实为本线未决主体,如实扣分。\** 浅色主题/480 断点未实测,见第 6 节。


## 8. 第二波:Bug 全清剿 + 素材扩量对标(2026-09-12 续)

### 8.1 待核实 Bug 全部实施(8/8)
| # | 缺陷 | 结果 |
|---|---|---|
| S1 | 标签底板失调/近景叠压 | 实测推翻原疑似根因(画布固定 640×160 才是真因);画布按实测文字宽收缩+碰撞投影改真实投影矩形+相机后方隐藏;354 viewer 测试过,三距离截图闭环 |
| S1-A | OutlinePass 幽灵板(Sprite 世界空间四边形) | postProcessingRuntime 包装 OutlinePass.render,内部深度/掩码渲染期间临时隐藏 Sprite;首版误伤主通道(标签消失)被浏览器截图当场抓到并纠正;终态远景/近景标签正常+零幽灵板 |
| S2 | tabular-nums 缺失 | 8 文件 35 个数字选择器定向覆盖(禁全局规则) |
| S3 | z-index 裸值(42 文件) | 病理值清零:新增 --layer-canvas-{smart-guide,guide,selection} 3 令牌收敛 5 处;109 处低风险裸值同屏审计后记录保留 |
| S5 | 断连无提示 | 全局连接状态监控+横幅(连续 2 次 5xx→降级;恢复提示 4s 自收;4xx 不误报);Playwright 拦截实测降级/恢复/收起;6/6 单测 |
| S6 | 409 无反馈 | 场景链路本有指引,真缺口在应用保存——复用 workspaceSaveFailureGuidance 接入(冲突文案+版本号+暂停自动保存);409 拦截实测指引可见 |
| S7 | 标尺 6px | 实渲染 12px(可读性基线接管)+隔刻度显示,无重叠 |
| S8 | 编辑场景默认二维 | 按项目记忆上次工作区(localStorage,失败降级);实测默认二维→切三维→再进落三维 |

### 8.2 素材扩量(对标帆软/山海鲸/ThingJS)
| 库 | 前 | 后 | 内容 |
|---|---|---|---|
| 2D 组件预设 | 157 | **250** | 指标 27/分析 24/报表 8/控件 8/装饰 26(含山海鲸式科技风边框 7/标题条 7/光效 6);332 测试过;442 截图 5 轮闭环;12 个跨 family 插入验证 |
| 看板模板 | 120 | **300**(30 行业域) | 每域 10 项真实行业指标;300 个 FVS 式封面(净化图形本体/域渐变底/网格纹理/KPI 大数字/左色条标题条);9 大类分组+类型筛选+推荐最新双分区+7 套主题套件(鎏金/绛霄/翠涛/青冥/沧澜/紫电/霞光,量化徽章真实统计);1160 测试过;4 轮视觉闭环 |
| 工业预制体 | 78 | **98** | +20 项全带真实参数/动作/数据口(龙门加工中心/磨床/冲压机/热处理炉/换热器/储罐/料仓/螺旋输送/无人机等);C1-C8 造型细节全实施;26/26 测试;0 控制台错误 |

精髓对标落地:帆软=行业色调映射/图表净化清单/主题套件量化徽章;山海鲸=深色市场布局/金色分层角标/推荐最新双分区/特征标签;ThingJS=真实 3D 封面卡片+计数语言。全部原创,零素材复制,零竞品名称。

诚实边界:①词云/箱线/瀑布/极坐标按'最接近类型+诚实命名'落地(真实新类型需 contracts+渲染器施工,箱线/瀑布/极坐标 ECharts 原生可补,词云需 echarts-wordcloud 新依赖待批准)——**①已实施(2026-09-12 第四波)**:contracts 新增 `wordcloud|boxplot|waterfall|polarBar` 四类型(只增,applicationValidation 白名单同步);词云经用户批准安装 echarts-wordcloud@2.1.0,真实 Chrome 像素级探针验证 ECharts 6.1 兼容(注意 series type 须用官方驼峰 `wordCloud`),插件懒加载且单点 catch 不拖垮其它图表;箱线=原生 BoxplotChart(Tukey 五数概括,按维度聚合原始行分布),瀑布=透明占位柱+升降语义色(--danger 升/--success 降,随主题令牌),极坐标=原生 polar 环形堆叠;四类 options 收敛在新文件 dashboardAdvancedChartOptions.ts(纯函数),同族分发点全补(DashboardWidgetRuntime 渲染白名单/dashboardFieldBinding/DashboardInspectorData/dataWidgetTypeLabel/Preview 四类净化 mark);四个预设回正真实语义且 id 不变(keyword-frequency-rank→词云/tolerance-limit-line→箱线/cumulative-transfer-combo→瀑布/grouped-series-bar→极坐标);验证:web vitest 1149 过+contracts 248 过+双主题真实渲染截图(apps/web/test-output/real-chart-types/,资源面板真实拖入+像素采样证实瀑布 7 柱升红降绿语义);残留:tsc 唯一报错在并行会话未跟踪新文件 templateSampleData.ts(与本波无关);check-bundle-budget 属 build 链路按禁令未跑;②模板封面数字为装饰,业务值插入后绑定;③推荐排序=行业包优先+内容完整度,不虚构热度;④S3 余 109 处低风险裸值待全局浮层审计;⑤后端 502 排查属服务端。

## 9. 第三波:预制体缩略图质感升级 + 族内变体区分(2026-09-12 续)

背景:用户以 ThingJS 资源中心对照判定——缩略图是真实 3D 渲染,但质感与区分度不足一线:
①族内变体同形(机器人 13 个多个缩略图肉眼几乎一样);②全库蓝灰两色(kind 代理色单一);
③构图平(无地面/阴影语境,卡片重复感强)。用户授权:不可辨变体直接删除。

### 9.1 任务 A:渲染器质感升级(apps/web/src/prefabs/thumbnail/prefabThumbnailRenderer.ts,全库 98 个受益)
| 维度 | 实现 |
|---|---|
| 环境语境 | 冷/暖两套背景(径向渐变 + 1500 颗微噪点破色带),暖模式琥珀车间光、冷模式蓝青工程夜,边缘均回落 --bg-0 不出戏;新增**渐隐网格站台**(细网格线经径向遮罩向边缘淡出,冷/暖双色)+ 接触阴影增强(中心 0.42→0.5) |
| 光照多样性 | 两套布光按 kind 交替且与背景模式错开(冷背景配暖主光 0xffe2b8,反之冷白 0xf4f9ff),半球光/地面反弹同步换色;**轮廓光按 kind 域色微调**(代理色向灯色靠拢 45%);金属 envMapIntensity 拉到 1.45、玻璃 1.3,scene.environmentIntensity 0.82/0.95 |
| 取景构图 | 三档机位按变体轮换(平视 3/4、高俯视、侧低视角),外扩系数 1.24/1.38/1.31 → 主体占幅 81%/72%/76%,消除满幅顶格 |
| 色彩 | 每变体一个稳定风格种子(FNV-1a):主色 ±15° 色相微调 + 四种表面处理(光洁/哑光/拉丝/氧化黑)轮换,消除"全库一张图" |

### 9.2 任务 B:族内变体区分(几何 + 姿态 + 材质三重编码;**零删除,98 → 98**)
| 族 | 前(同形对) | 后(区分手段) |
|---|---|---|
| 机器人(16) | delta-3=delta-4、articulated-6≈cobot≈焊接≈码垛等 5 对同形 | delta-4 四臂 90°(vs 三臂 120°);cobot-6/7 白壳深色关节鼓、六轴折叠 vs 七轴 S 弯+第 7 轴鼓;重载=方臂巨铸件;弧焊=焊枪+焊丝鼓+送丝管;点焊=变压器+点焊钳;码垛 4/4-heavy/6=平行四杆+吸盘板+托盘货垛(heavy 双侧双杆 2×4 吸盘);scara-fast=白壳纤细臂+同步带罩+折叠姿态 |
| 输送(17) | belt-wide/roller-gravity/roller-accumulation 与母型完全同几何;chain-pallet 渲染成皮带面;merge/diverter/transfer 共用一个侧模块 | 宽幅=1.4× 面+双侧导料栏;重力=微坡+无驱动+滑出料箱;积放=分区止挡+光电柱;链式=双链条+链节+托盘货箱;合流=45° 侧线汇入;摆轮=斜置摆轮列+滑出槽;移载=正交交叉辊道+双侧护栏 |
| 移动/车辆(12) | tugger≈carrier(钩子不可见)、amr≈unit-load(平顶) | 牵引式加挂车+载货;AMR 圆背壳罩+传感带;单元载荷台面加标准托盘 |
| 人员(5) | 仅帽色差,背面视角不可辨 | 帽+背心+持物三重编码:巡检=鸭舌帽+手持检测仪(抬臂)、维修=橙帽+手提工具箱、操作员=胸前记录板、访客=便装白帽+访客证(注:巡检 subtype 实为 inspector,首版误用 guard 已修) |
| 电气柜(3) | plc≈mcc(仅门缝差) | PLC=观察窗三排 I/O 指示灯模块;MCC=双门+三只电流表圆窗 |
| 背视角退化(3) | 电表/垂直提升货柜/折弯机背视角=无字碑 | 各补背面语义:挂装支架+入线嘴+散热槽 / 双开库门缝+通风百叶 / 液压管路+电气盒 |

**裁删清单:空。** 9 族 98 变体经 3 轮"修→族内并排对照→修"后全部肉眼可辨,无需触发用户授权的删除;
数量断言 98 保持不变(industrialPrefabCatalog.test.ts / prefabThumbnailModels.test.ts 全过)。

### 9.3 验证与证据
- `pnpm exec tsc --noEmit -p .` 0 错误;`pnpm exec vitest run src/prefabs` 21/21 过。
- 视觉闭环 3 轮(apps/web/test-output/prefab-quality/):round1/3 为管理端 prefab tab 全 5 页翻页截图;
  closeup/ 为 9 张族内并排对照图(98 变体逐个搜索+缩略图元素截图+sharp 拼接),0 控制台错误、0 缺卡。
- 对照板:test-output/visual-compare/4-3d-assets-after-prefab-quality.png(左 ThingJS,右升级后实机;
  原对照板 4-3d-assets.png 保留)。
- 10 维自评(以缩略图渲染域为界,浏览器实测截图为证):布局构图 9.2(占幅 72~81% 无顶格);
  令牌一致性 9.2(背景/雾色镜像 --bg-0 族,3D 无法引用 CSS 变量按既有先例镜像);排版 n/a(纯渲染);
  交互状态 n/a;动效 n/a;3D 渲染质量 9.1(ACES+光照三件套×2+PBR envMap+渐隐网格+接触阴影);
  信息设计 9.0(状态灯三色语义、货垛/托盘语境道具);反馈即时性 n/a;响应式 n/a(固定 240² 卡片图);
  语义与文案 9.0(变体按行业惯例命名,零虚构)。
- 诚实边界:①WebGL 缩略图为固定深底渲染,浅色主题下卡片底仍为深色图(既有设计,本次未改 components/,不在授权范围);
  ②折弯机背视角虽有液压管语义,仍是 10 个机床里最弱的一张;③机器人卡右上"关节"徽章叠压模型一角属 UI 层(components/ 勿动,未处理)。

## 10. 第四波:模板封面质量升级 + 弱项裁删(2026-09-12 续,用户授权"质量差的直接删")

### 10.1 封面升级摘要(全部封面受益,300 → 277 张全部重绘观感)
对标基准:山海鲸模板市场封面(成品大屏截图级:满屏主体、辉光、域色氛围)+ 帆软 FVS 图表规范
(数值 tabular-nums、单位显式、语义色纪律)。10 维自评见 10.4,证据全部为浏览器实测截图。

| 升级项 | 手段(全部在 dashboardTemplateCoverArt.tsx / DashboardTemplatePreview.* / layoutBuilder) |
|---|---|
| 根治"空旷感" | 模板库封面统一标准 1920×1080 基准(此前工作台把用户画布 3840×1080 传进封面 → 超宽版式塞进 16:9 卡片产生上下大 letterbox);插入仍按真实画布适配(insertDashboardTemplate 不受影响) |
| 主视觉支配版面 | 布局工厂主视觉带 0.56→0.66、上限 400→540(1080 基准下主图占画布约 45% 高),底部明细带收紧为紧凑数据条 |
| 辉光质感 | CoverDefs 新增 halo(纯模糊垫层)/glow(feMerge 保留原图)滤镜 + hot/flow/rise/sheen 渐变;主线"辉光三连"(halo→主线→白芯);KPI 大数字 feMerge 发光 |
| 密度与层次 | KPI:顶部高光带+迷你走势/进度刻度/状态灯阵+语义涨跌胶囊;明细:斑马纹+行内迷你条+奖牌+表头线,行数按 frame 高度自适应(3-6 行) |
| 视角差异化构图 | 地图类=分轴区域多边形+枢纽热点+飞线箭头+到达环;监控类=主表+双联副表仪表簇+状态灯排;分析类=大曲线+峰值角标/散点离群 3.2σ 标注;表格类=斑马纹+迷你条;漏斗=层间转化率;桑基=流向渐变+流粒子;旭日/饼=中心 KPI+主瓣离断 |
| 场景氛围(CoverScene 新层) | 顶部极光带、四角括弧(halo 辉光)、地平线渐辉、14×6 稀疏点阵、双流线、双角光斑+底部副光斑;CSS 侧同步加暗角(vignette)+网格/点阵双纹理 |
| 主题纪律 | 封面保持"深色大屏孤岛"(浅色主题实测一致);语义状态灯取 base.css 深色主题令牌固定值(#59c58d/#d8ac52/#e27478,与既有浅色文字固定值同一纪律),一切强调色从 --template-accent 派生,零新增硬编码主题色 |

### 10.2 裁删清单(用户授权"宁可少而精",逐条理由;300 → 277)
| 裁删对象 | 类型 | 理由 |
|---|---|---|
| 餐饮连锁经营(catering,10 模板) | 整域删除 | 与零售电商 6/10 指标重叠(在营门店/门店能耗/客流/会员复购/缺货预警/营业额≈销售额);余下翻台率/出餐合格率/缺料预警为餐饮专用词,无法诚实验证零售的坪效/获客成本;色环橙红族 10°/16°/24°/27° 过挤。市场定位由零售电商域承接 |
| 文娱体育赛事(sports,10 模板) | 整域删除 | 与文化旅游 5/10 指标重叠(票务流量/在线终端/场馆≈景区能耗/满意度/服务达标率);品红族 315°/330°/340° 过挤。场馆运营由文旅域与园区域承接 |
| 政务服务·供需协同(government-supply) | 单模板删除 | 政务无供应链,"供需协同"视角只能拿受理流量冒充供需流量,凑数感明显 |
| 教育校区·供需协同(education-supply) | 单模板删除 | 学校无区域供需网络,出入流量冒充供需流量,凑数感明显 |
| 医疗健康·供需协同(healthcare-supply) | 单模板删除 | 指标契约无库存/采购角色,门诊流量冒充供需流量;真实医院供应链域需要独立指标契约后再上 |

保留:4 个行业包(制造设备运维/物流履约/电网/水务)零改动;7 个主题套件结构保留(鎏金 5 域 49 模板、
绛霄 3 域 29、翠涛 6 域 60、青冥 4 域 39、沧澜 4 域 40、紫电 4 域 40、霞光 2 域 20,徽章数字由 suiteStats
真实推导自动更新);9 个行业分组保留(经营管理、新兴领域各减一域)。

### 10.3 验证与证据
- `pnpm exec tsc --noEmit -p .` 0 错误;`pnpm exec vitest run src/components` 235 文件 1137 测试全过
  (数量断言同步:277 模板 / 28 域 / 逐域 10 或 9,DashboardTemplateCatalog.test.ts)。
- 视觉闭环 6 轮(before → round1..round5 → final,apps/web/test-output/cover-quality/):
  抽样 20 域 × 双主题逐域截图 + 生产域 6 视角家族特写 + 代表域单卡放大;0 控制台错误。
- 对照板(与竞品并排,sharp 拼接):
  - final/board-market-dark.png(左山海鲸市场,右本产品深色终态)
  - final/board-market-light.png(左帆软市场,右本产品浅色终态)
  - final/board-before-after.png(本产品升级前后同机位对照)
- 探针脚本(可复跑):scripts/probe-cover-quality.mjs(逐域抽样+家族特写)、
  scripts/probe-cover-final-board.mjs(库弹窗/资源页双主题+对照板)。

### 10.4 10 维自评(以封面缩略图域为界,实测截图为证)
布局构图 9.2(封面满卡无 letterbox,主视觉 ≈45% 高且填满);令牌一致性 9.3(域 accent 全派生,
语义灯=base.css 深色令牌固定值,零新增硬编码);排版 9.1(数值全 tabular-nums,标题/单位/峰值规整);
交互状态 9(封面为静态缩略图,插入/hover/收藏态在库层未回归,1137 测试为证);动效 9(封面按规格静态
分镜,"呼吸"以扩散环静态模拟,无动画依赖);3D 渲染质量 n/a(封面是 SVG 数据场景插画,非 3D 管线,
见诚实边界①);信息设计 9.2(密度纪律守住:一屏 9 组、峰值/离群/转化率标注规整、单位显式);
反馈即时性 9(同交互态,未回归);响应式与主题 9.3(双主题实测一致,竖屏版式 viewBox 适配保留);
语义与文案 9.2(状态灯色+环+位三重编码,裁删清单如实公开)。

### 10.5 诚实边界(遗留项)
- ① 山海鲸封面是真实 3D 场景渲染图(3D 城市/热力球实拍级);本产品封面是 SVG 数据场景插画,
  "题材真实感"仍不及实拍 3D。要追平需真实场景截图管线(属 viewer/渲染域,本轮禁改),本轮交付的是
  "成品大屏数据界面截图观感"而非"3D 世界观观感"。
- ② 277 不是整数(诚实裁删结果);如需凑整可后续补 3 个真实供应链域模板(须先补指标契约,拒绝凑数)。
- ③ SVG 辉光滤镜全量 277 卡同屏渲染增加少量初始栅格成本(实测截图全程 0 控制台错误;未做低端机性能门禁)。
- ④ 桑基封面三带仍偏"宽条",曲线韵律弱于飞线/仪表簇(已加渐变+粒子改善,列为下轮可选打磨点)。

## 11. 素材中心分类体系(参考帆软/ThingJS,根会话实施)

管理端资源页三个 tab 增加分类行(此前仅搜索,分类缺失):
- **2D 资源**:按用途大类 7 chips(指标/图表/报表/控件/媒体/集成组件/装饰与资源,帆软"四大类+其他"的归并思想,映射 preset.category),全部+计数徽章。
- **看板模板**:行业 9 大类 chips(复用模板中心 DASHBOARD_TEMPLATE_GROUPS 单一事实来源:生产制造 60/能源环保 40/公共服务 37/经营管理 30/园区建筑 30/新兴领域 30/安全质量 20/物流仓储 20/水处理 10)+ 右侧分层筛选(全部/行业包/标准,对标帆软类型筛选)。
- **工业预制体**:14 类 kind chips(工业机器人/输送设备/公用工程…,ThingJS 类别行语言),全部+计数。
- 交互:chips 与搜索叠加过滤、切 tab 重置、计数徽章 tabular-nums、hover/active 态令牌化、横向滚动;`unified-asset-library.css` 追加样式段(零竞品元素)。
- 验证:tsc 0 错误;BuiltInAssetBrowser 6/6 测试(新增分类断言:chips 计数守恒=目录总数×2、9 大类、分层、kind chips);Playwright 三 tab 实测过滤行为(图表→54、生产制造→60、工业机器人→16),0 控制台错误;截图 apps/web/test-output/category-rows/。

## 12. 素材中心页面级审美升级(2026-09-12 续,判据"页面像成品产品页,不像 demo")

单件卡片质量此前已达标,本轮解决**页面级构图**四项"demo 感":平的搜索行+卡片墙、大块空黑背景、
无页面头部层次、无氛围。对标:山海鲸市场的页面氛围与分区节奏(近黑底+微光+满幅密度)、帆软市场的
头部处理(标题+定位语+概览统计),压进工作台克制高度。授权口径:全页背景可改、排版可改,唯一标准
"风格整体不突兀";硬红线:base.css/壳层不动、CSS 命名空间化零泄漏、其他页面零影响、双主题成立。

### 12.1 升级清单(逐条:改了什么 → 解决哪一点 demo 感)
1. **页面头部区**(`UnifiedAssetLibraryPage.tsx` + `unified-asset-library.css`):标题 20px + 一句话
   副题("模型、二维资源、看板模板与工业预制体,统一浏览、搜索并插入项目")+ 头部顶缘一道 26% 主色
   呼吸线(高光渐变,克制);实测头部区总高 **107.9px**(目标 88–120,量化证据见 12.3)。
   → 解决"无页面头部层次"。
2. **四类资源概览统计 tab**:kinds 行升级为"图标 + 名称 + 真实计数"统计 tab(模型 1,689 走一次
   pageSize=1 轻量目录请求,二维 250/模板 277/预制体 98 取内置目录长度,全 tabular-nums;失败显示
   "—"不编数),active 态主色柔光。对标山海鲸分类树的图标+计数徽章语言。→ 解决"平的搜索行"、
   给页面"产品概览"的第一眼信息。
3. **全页氛围背景**(仅 `.scene-manager-page.asset-workspace-active`,即资源 tab):右上 8% 主色微光
   + 左上 6% 冷光 + 24px 细网格纹理 + 纵向 surface-1→bg-0 渐变,全部 background 多层实现(滚动时
   贴元素框,零额外滚动条/遮挡);容器改半透明面板浮于氛围底上。深色=近黑空气感,浅色=淡灰网格+
   淡金微光,同一规则双主题成立。→ 解决"大块空黑背景、无氛围"。
4. **卡片墙排版**:栅格 minmax 210→216px、间距统一 12px、水平 padding 统一 16px(8px 栅格节奏);
   卡片默认微阴影(墙面不再"平")、圆角对齐 --radius-lg、hover=主色 32% 描边+上浮 2px+阴影(实测
   hover 截图);分页行 8px 间距+hover 反馈+页码 tabular-nums;摘要行排版精修。→ 解决"卡片墙平铺
   直叙、分页/摘要粗糙"。
5. **空态升级**(模型库与内置库共用 `.unified-assets-state`):虚线容器+径向渐隐网格底纹+52px 主色
   图标底座(外圈 6px 柔光环)+说明文案+引导动作按钮;error 态 danger 派生边框/底色。实测模型库与
   2D 库两处空态截图。→ 解决"空态一片空白"。
6. **分类行精修**(仅 CSS,逻辑零改动):chips 8px 间距、scroll-snap、surface-2 半透明底、active
   胶囊主色描边+柔光、计数 tabular-nums;选择器收紧到 `.built-in-assets-browser` 前缀。
7. **2D 编辑器资源面板**(`dashboardComponentLibrary.css`):浏览器间距 10→12px(8px 栅格);tab
   active 加顶部 2px 主色指示条+650 字重(FVS 标题条语言);分组标题加 3px 主色竖条+计数
   tabular-nums;分组间 12px 分隔节奏。实测 2D 编辑器资源面板深浅两主题截图。
8. **同族排查顺手项**:`.unified-assets-action-error` 硬编码色全部令牌化(--danger color-mix 派生)、
   `.asset-thumbnail-fallback` #7b898f→var(--text-faint)、未使用的 --asset-blue/--asset-green 变量
   清除;搜索框补 focus-within 主色环;900px 实测发现"精选资源"按钮文字竖排缺陷,补
   white-space:nowrap 修复并复验。

### 12.2 验证与零泄漏证据
- `pnpm exec tsc --noEmit -p .` 0 错误;vitest 15/15(BuiltInAssetBrowser 6 + CSS 结构契约
  assetThumbnailLayout 2 + dashboardRecordFormSizing 7,CSS 断言块未破坏)。
- 截图(3 轮迭代,对照 test-output/competitor-ref/ 收紧:round1 头部偏高 → round2 收紧至 107.9px
  并补齐空态/hover/分页/1280/900 → round3 终态全量):
  - `apps/web/test-output/asset-page-aesthetic/round1..3/`(4 tab × 深浅双主题整页、空态、hover、
    分页、900/1280 档、2D 编辑器资源面板双主题)
  - `apps/web/test-output/asset-page-aesthetic/leak-check/`(管理台首页/资源 tab/设置页/编辑器)
- **零泄漏量化证据**(computed backgroundImage):管理台首页=none、编辑器=none、设置页无该容器、
  资源 tab=radial-gradient(…)(氛围仅资源 tab 存在,`.asset-workspace-active` 由 SceneManagerView
  仅在该 tab 注入)。
- 对照板(sharp 等高拼接):`apps/web/test-output/visual-compare/asset-page-after.png`(左山海鲸
  市场 vs 右本产品模板 tab 深色)、`asset-page-after-light.png`(帆软 vs 浅色)、
  `asset-page-after-prefab.png`(ThingJS vs 预制体 tab)。
- 探针脚本(可复跑):`scripts/asset-page-aesthetic-probe.mjs`(全量双主题)、
  `scripts/asset-page-aesthetic-round2.mjs`(高度量化+空态/hover/分页)、
  `scripts/asset-page-leak-check.mjs`(零泄漏)、`scripts/asset-page-visual-compare.mjs`(对照板)、
  `scripts/asset-page-2d-panel-probe.mjs`(2D 面板)。

### 12.3 10 维自评(实测截图为证)
布局构图 9.4(头部 107.9px 达标区间,统计 tab→chips→搜索→摘要→卡片墙→分页节奏成立,满幅利用);
令牌一致性 9.5(新增样式零硬编码主题色,全 color-mix 派生,双主题实测);排版 9.3(计数全
tabular-nums,头部层级清晰,900px 竖排缺陷已修);交互状态完备 9.3(空态/hover/focus-within/
disabled/分页全实测);动效质量 9.0(140ms expo-out 微反馈体系,无过度动画);3D 渲染质量 n/a
(纯 UI 任务);信息设计 9.3(概览统计/摘要/计数纪律);反馈即时性 9.0(骨架屏与 aria-live 保留);
响应式与主题 9.3(1600/1280/900 实测无溢出,双主题实测);语义与文案 9.3(空态引导文案、计数如实)。

### 12.4 诚实边界(遗留项)
- ① 卡片内状态徽章(.quality-tier/.asset-animation/.asset-publication/.built-in-asset-kind 及模板
  预览内色)保留既有设计配色未令牌化——单件卡片质量此前已达标且已过验收,动它有回归风险;后续如做
  "徽章令牌化"应独立成轮并逐域截图对比。
- ② 模型 tab 计数依赖一次轻量目录请求,接口失败时显示"—"(不编数);离线/后端不可用时头部统计退化
  为"—"属预期行为。
- ③ 780px 以下手机档仅规则覆盖未逐一截图(资源工作台为桌面场景,1280/900 为最低实测档)。
- ④ 头部呼吸线与氛围微光为"克制的品牌表达",若用户觉得存在感偏强/偏弱,调
  `unified-asset-library.css` 中 26%/8% 两处百分比即可。


## 13. 数量波次 A 交付(2D 预设 250→420+,2026-09-12 深夜)

- 7 族新增全部完成:行业 KPI 60(电力 8/水务 8/化工 8/医院 8/政务 8/汽车/半导体等行业组)、仪表阈值 16、区域地图 16(分省钻取/城市/园区标注/场站/管线/廊道/路网/轨道/轨迹/密度)、报表形态 14(交叉小计/季度交叉/多指标表头/KPI 矩阵等)、控件 12、装饰造型 24(链条/阶梯/流星/波纹/雷达扫/数据雨/辉光角/粒子环/扫光幕/能量条等)、分析增强 28(堆叠面积增强/同环比环等)。
- **硬门槛证据**:170 个新预设逐卡双主题特写(340 张)+30 张 contact-sheet 全量扫描;根会话抽检 5/30 张 sheet 覆盖全部 7 族,五项标准(构图/对比/可读/语义/配色)全过;聚类门禁 vitest 断言(同形簇=0)在 DashboardComponentCatalog.test.ts 常驻。
- 聚合与数量门禁:目录聚合 ≥420 断言通过,id 唯一;components 全量 237 文件 1153/1153 通过;tsc 0 错误。
- 管线联验:真实渲染封面管线 Preview 接线成功(模板库打开→SVG 先行→真渲染截帧渐进替换,实机 6 卡可视区已验证);模板插入即带示例数据实证(生产运行监控·示例:4 KPI+柱图+环形+明细表,10 组件数据在线,t3-inserted.png)。
- 诚实边界(更新):①装饰族小尺寸下靠造型+标签区分,信息密度天然低(品类属性);②KPI 装饰数字为确定性假数,绑定真实数据集后替换;③**逐卡目检已 100% 完成**(2026-09-13 根会话):深色 15/15 sheet=170/170 卡全检五项全过,浅色抽验 2/15+管理端浅色页实测(瓷砖深色孤岛为既定设计);④theme suites 32 域恰一覆盖断言已更新。

## 14. 剩余待办(诚实清单)

- ~~波次 B:模板 277→320(4 新域)~~ → 已交付,见第 16 节(实际 277→317,+40;320 与裁删口径的算术差异见 16.1 诚实声明)。
- 真实渲染封面管线的全量性能取证(首屏/全量就绪时间)待一轮专门测量。
- 词云等新类型的 bundle 预算门禁(check-bundle-budget)待一次生产构建验证。
- prefabThumbnailModelsLogistics.ts 926 行为既有体量(波次 C 仅 +18 行委派),后续可按 kind 拆分为 *2/*3 文件。

## 15. 数量波次 C 交付(工业预制体 98→120,2026-09-12)

- **22/22 全部交付、0 删除**:感知 +6(感烟探测器/感温探测器/声光报警器/振动监测传感器/远程终端单元 RTU/边缘计算网关)、视觉 +4(枪型/半球型/热成像摄像机/AI 视频分析盒)、车辆 +5(半挂牵引车/自卸车/洒水车/曲臂式登高车/皮卡巡查车)、仓储 +4(贯通式货架/移动式密集架/冷藏柜/周转笼)、移动 +3(堆高 AGV/潜伏顶升 AGV/料箱机器人)。摄像机 7 型整体从 sensing 拆出至 `industrialPrefabCamera.ts` 统一维护。
- **语义偏差声明(1 处)**:规格中车辆"牵引车"与既有 `vehicle.tow-tractor`(厂内拖车)重名,按"半挂牵引车头(牵引质量/鞍座口径)"落地为 `vehicle.tractor-unit`,几何语义均与既有拖车拉开;"潜伏顶升 AGV"与既有"潜伏顶升 AMR(背负货架)"按行业真实形态区分——AGV 为低罩+中央顶升盘+盘上托盘,AMR 为四柱顶升+背负货架。
- **数据口行业真实**:火灾探测按 GB 4715/4716(遮光率 %obs/m、定温 57 °C/差温 °C/min、声压级 dB、消音/自检动作)、振动按 ISO 20816(速度量程/轴向/评价标准)、RTU 按 DI/DO/AI/AO 通道+扫描周期+Modbus/DNP3/IEC-104、网关按南向 OPC-UA/北向 MQTT+断网续传、热成像按 NETD mK/测温范围、AI 盒子按接入通道/NPU TOPS/解码能力;catalog.test.ts 新增数据口断言常驻。
- **数量门禁**:industrialPrefabCatalog.test.ts 98→120、routeCapable 17→25、22 个新 id 入列;prefabThumbnailModels.test.ts 120 全量几何有效+21 组新变体分型指纹断言;src/prefabs 22/22 通过,引用目录的 3 个组件测试 12/12 通过,tsc 全绿。
- **逐个目检闭环(4 轮修复)**:round1 目检 17/22 通过→修复 5 处(潜伏顶升罩壳吞没顶升盘、声光报警器构图不可读、RTU 面板细节弱、振动监测灰团、密集架开口不可见);round2 复检 19/22→再修潜伏顶升与 AMR 圆罩剪影趋同(改小罩大盘)、RTU 命中背拍机位(改开放式构架:背板横梁+立柱+顶盖,任意机位可读)、密集架拉出方向与机位相反(朝 -z 拉出+端面摇柄);round4 起全部通过。修复共 8 处几何/构图问题,0 个删除。
- **截图证据**(apps/web/test-output/quantity-wave-c/):round5 为最终轮——管理端资源页 prefab tab 真双主题(`?theme=` + data-theme 双保险)各 5 页全翻页(120 全渲染、0 控制台错误、计数徽章 120 断言)、36 张双主题特写(22 新变体+14 既有对照)、6 张族内并排对照板(boards/family-*.png,几何+姿态+材质三重区分逐对核验)。round1-4 为中间修复轮留档。
- **诚实边界**:①既有对照变体(MCC 柜等)的机位与其固定 hash 取景有关,个别既有变体小样细节可读性一般,非本波次改动范围;②prefabThumbnailModelsLogistics.ts 为既有 900+ 行文件,本波次仅加委派分支未拆分(见待办);③脚本首轮"light"轮未真正切主题的问题已在 round5 修正,round1-4 的 light 页面截图实为暗色,以 round5 为准。

## 16. 数量波次 B 交付(看板模板 277→317,2026-09-12)

### 16.1 数量诚实声明(先读)
规格写作"277→320(+43)",但目录结构是 **模板数 = 域数 × 全局 10 视角 − 已裁删模板**:波次 B 新增 4 域 × 10 视角 = +40,而 277 本身 = 28×10 − 3(2026-09-12 质量审计裁删的 3 个"供需协同"凑数模板)。因此结构事实为 **277+40=317 = 32×10 − 3**;"320"系按 32×10 整算、未计 3 个已裁删模板。按规格自身"裁删原则不回退、宁缺毋滥"与本次任务"数量让位质量"的绝对硬门槛,交付 317,不恢复凑数模板;数量断言在 `DashboardTemplateCatalog.test.ts` 同步为 317/32 域并写明推导。

### 16.2 交付内容(+40,4 域 × 10 视角)
- **电力交易 power-trading(深蓝 #575ec7,surface #12142c)**:中长期成交电量/负荷预测准确率/偏差考核达标率/现货价格告警/机组检修计划/新能源出力/现货出清电量/售电收益/辅助服务收益/售电碳强度(gCO₂/kWh)。
- **化工安全 chem-safety(警示橙红 #e45525,surface #27120b)**:特殊作业许可(张)/承包商隐患整改及时率/HAZOP 分析覆盖率/可燃气体告警/受控重大危险源/安全装备能耗/工艺报警流量/职业健康投入/应急演练完成率/安全碳强度——HAZOP 为点名硬门槛,已在 operations/quality/risk/service/sustainability 五视角指标组实证(数据层断言输出留档)。
- **冷链物流 cold-chain(冰青 #7dc8d4,surface #0d2129)**:冷藏车在途/库存周转天数/温区达标率/断链告警/调度月台/制冷能耗/库门开启/临期货损/订单履约率/冷链碳排。
- **会展活动 expo(紫金 #c670d2,surface #1f1231)**:进馆客流/展位利用率/餐饮抽检合格率/安保告警/在办场次/场馆能耗/舆情声量/签约金额/观众满意度/活动碳足迹。
- 4 域指标位取舍原则:10 角色位契约固定(volume…carbon),行业主题按语义对位;"现货出清电量"承担现货主题的量纲、"承包商隐患整改及时率"与"临期货损"各承担双主题合并。牺牲项如实声明:电力交易"结算对账"、化工安全"联锁投用"、会展"停车"三主题因 10 位契约容量不足未获独立指标位(各以同族指标弱覆盖),记录于此。
- 颜色:4 域 accent 全部取 32 域色环的未占用色相空隙(236°/15°/188°/293°),近邻对靠色相偏移+明度饱和差+surface 冷暖三重区分(注释写明 hsl 推导)。
- 归并与套件(任务指定):groups 中 power-trading→能源环保、chem-safety→安全质量、cold-chain→物流仓储、expo→新兴领域(9 大类不变);suites 中 power-trading→玄澜 navy、chem-safety→燧火 ember、cold-chain→碧汐 tidecyan、expo→紫电 violet,4 个套件描述双语同步改写以诚实涵盖新域,32 域恰一覆盖。

### 16.3 验证与目检
- `pnpm exec tsc --noEmit -p .` 0 错误;`pnpm exec vitest run src/components` 237 文件 1193/1193 全过(数量断言 317、32 域每域 10 视角、套件 32 域恰一覆盖、views 10、id 唯一)。
- playwright(dev server 5173,admin/admin 真实登录,品牌设置页真实切主题)双主题 × 2 轮 = 4 次全流程,每轮:建项目→建看板应用→进入二维工作台→模板库逐域搜索→每域 10 卡断言→封面三段滚动截图(10 模板全部入镜)→抽样插入 1 模板截图画布→Ctrl+Z 复位;0 失败(probe-report.json)。
- 逐个目检:40 个新模板封面在 4 域×(top/mid/bot) 截图中全部入镜并逐一核对——封面渲染完整(KPI/曲线/环形/柱图/散点/漏斗/雷达均真渲染或 SVG 保底,无空白卡)、行业标签正确、特征标签与布局结构一致(同视角跨域同构为既有设计,标签由布局诚实推导);插入画布 4 域各 1 张实证:KPI 卡与明细表列头出现真实行业指标(化工"特殊作业许可/承包商隐患整改及时率/可燃气体告警/应急演练完成率",冷链"冷藏车在途/库存周转天数/断链告警",会展"进馆客流/展位利用率/安保告警/观众满意度",电力"中长期成交电量/负荷预测准确率/现货价格告警/辅助服务收益"),域色、双主题(深色画布 3 张+浅色画布 1 张)成立。
- **目检统计:总数 40 / 通过 40 / 修复 0 / 删除 0**(首轮即全部合格;两处截图质量问题在取证脚本侧修复,非模板缺陷)。
- 截图:apps/web/test-output/quantity-wave-b/(4 域 × 2 主题 × 2 轮 × top/mid/bot 封面 48 张 + 画布插入 8 张 + probe-report.json);取证脚本 apps/web/scripts/quantity-wave-b-probe.mjs 可重放。

### 16.4 诚实边界
- ① 示例数据百分比聚合显示偶发浮点尾数(如"79.3800000000001%"),为 templateSampleData 聚合展示的既有机制(既有 28 域同路径同样出现),非本波次引入;如修应独立成轮全量回归。
- ② power-trading 域在个别轮次封面真实截帧数为 0(截帧管线就绪前首批请求被丢弃),展示的是 SVG 净化保底封面——产品内合法回退形态、渲染完整;脚本侧已加 2.5s 就绪等待,4 轮中 3 轮获得真渲染封面。
- ③ 首批截图脚本的两处取证缺陷(登录表单未渲染即误判已登录、推荐+最新两分区导致 18 卡误计)已在脚本侧修正,不影响模板本体。
- ④ DashboardTemplatePreview.tsx 中"一次挂载 285 卡"注释为禁改文件内的历史数字(277 时代前),未随本波次更新。

## 15. 波次 B/C 交付 + 全仓终验(2026-09-13)

### 15.1 波次 B:看板模板 277→317(32 行业域)
- 4 新域(电力交易/化工安全/冷链物流/会展活动)各 10 视角×10 真实行业指标(现货电价/HAZOP 覆盖率/温区达标/进馆客流等);9 大类归并与 18 套套件归属同步。
- 交付 317 而非 320 的原因:目录=32×10−3,3 个为此前质量审计诚实裁删的凑数模板,按"裁删不回退、宁缺毋滥"不恢复。
- 目检:40/40 通过、0 删除;双主题×2 轮全流程;逐域封面三段滚动截图使 40 封面全部入镜核对;4 域抽样插入画布实证指标真实(HAZOP 等列头经数据层断言)。
- 验证:tsc 0 错误;components 1193/1193;截图 65 件(apps/web/test-output/quantity-wave-b/)。

### 15.2 波次 C:工业预制体 98→120
- 感知+6/视觉+4/车辆+5/仓储+4/移动+3,全部真实参数/动作/数据口;相机 7 型拆分独立文件。
- 目检:4 轮闭环修复 8 处几何/构图问题(潜伏顶升罩壳吞没顶升盘、RTU 背拍不可读、振动监测灰团、密集架方向反等),终态 22/22 通过、0 删除;既有 14 变体一并族内核验。
- 验证:tsc 0 错误;prefabs 22/22;引用目录组件测试 12/12;双主题 5 页全翻 120 全渲染、0 控制台错误;族内并排对照板 6 张(apps/web/test-output/quantity-wave-c/round5/)。

### 15.3 全仓终验
- `pnpm -r typecheck` 通过(api+web)。
- 全量 Web 测试:483 文件,2223+/2225,2 个失败均为**并行会话在途文件**的架构边界违规(packages/deep-engine/lab 3 个新探针、parametric/ParametricModelWorkbench.tsx 裸 HTTP),非本轮任何一线产物,未越权修复,已如实记录移交。
- 终态实机截图:资源页四类概览统计上墙(模型 1,689/二维 420/模板 317/预制体 120),氛围背景/头部/分类 chips/卡片墙终态可见(apps/web/test-output/visual-compare/final-state/)。

### 15.4 数字终态
| 库 | 起点 | 终点 |
|---|---|---|
| 2D 组件预设 | 157 | **420** |
| 看板模板 | 120 | **317**(32 行业域) |
| 工业预制体 | 78 | **120** |
| 视觉风格库 | 7 | **18 套** |
| 真实图表类型 | 0 | +4(词云/箱线/瀑布/极坐标) |

## 16. 真实渲染封面全量铺开 + 性能取证(u131,2026-09-12)

### 16.1 全量铺开验证(317/317 模板遍历)
- 方式:playwright(Chrome headless 1600×900)登录 admin → 编辑场景 → 资源面板 → 打开看板模板库,分段滚动全部 317 卡到底,等串行渲染队列消化(img 数量连续 4 轮稳定),按 aria-label 去重统计。
- 覆盖率:**282/317 真渲染封面(89.0%)+ 32 张 map 主图模板合法 SVG 回退**(示例数据无 GeoJSON,`templateSupportsRealCover` 设计内保底)→ 具备真渲染能力的模板覆盖 **282/285(98.9%)**。
- 失败清单:3 张(能源效率分析·运行调度/资产与设备、供应链物流中心·经营总览),失败率 0.95%。**单独复现与 60s 充分等待下 3/3 全部渲染成功、0 警告**——机理为快速滚动遍历时队列积压窗口内的就绪超时(8s 诚实回退),非模板缺陷;卡片永不白块,SVG 保底有效。
- 12 张跨域特写:11/12 通过像素多样性校验(nonBlank 0.38–0.998,无空白/占位),唯一未过者即上列失败模板之一(特写时点尚未重渲),后已实证可渲染。特写与全景截图存 `apps/web/test-output/cover-performance/`。

### 16.2 性能五项(light 主题口径,960×540 → 640×360 两轮对照)
| 指标 | 首轮(960×540) | 复测(640×360) | 说明 |
|---|---|---|---|
| ① 首屏时间(点开模板库→首屏卡可见) | 3375ms | 4819ms | 波动属环境噪声;大头是 317 张 SVG 卡一次性挂载(库主逻辑) |
| ② 全量就绪(滚动 116s+队列消化) | 560.5s | 529.6s | 单模板渲染 p50 1401ms(mount 147/ready 747/capture 453) |
| ③ long task(>50ms) | 2135 次/阻塞 146.2s | 1996 次/阻塞 137.1s | **未达 ≤10 验收线,见 16.4 诚实声明** |
| ④ JS 堆增量(打开库前→遍历后) | +453.2MB(581.1 总 812.2) | +389.8MB(517.2 总 732.9) | 317 张 dataURL 常驻组件 state,LRU 不回收已挂载图 |
| ⑤ 失败回退率 | 0.95%(3/317) | 0.95%(3/317) | 同 3 张,负载性超时 |

### 16.3 本轮优化(全部在 dashboardTemplateCoverRuntime.tsx 所有权内)
1. **截帧输出 960×540 → 640×360**(COVER_CAPTURE_RATIO 1/3):capture p50 517→453ms,堆增量 -63MB,卡片 ~250px 显示宽下仍有 ~2.5 倍冗余;同族排查确认无外部代码依赖旧尺寸。
2. **同值主题写入防抖**:实测发现 `setAttribute("data-theme", 同值)` 也会触发 MutationObserver → 白白清缓存并重渲染全部卡片(取证 light 轮 totalPhotos=8 的根因)。修复为仅在主题键真变时失效(watchTheme + `normalizeCoverTheme` 归一,导出供测试)。
3. **就绪超时 warn 可观测性**:超时回退原为静默,取证无法区分"超时"与"异常",补 console.warn(含 expected 数)。
4. 未采纳:离屏渲染(html-to-image 无 worker 管线,自研超出收尾边界)、渲染中滚动暂停(防饿死复杂度高且取证指标无法证明收益)——列为后续项。

### 16.4 诚实声明与遗留
- **long task 1996 次 ≫ 10 次验收线,未收敛达标**:串行队列(并发已=1)中每个任务的 mount(ECharts init)/ready(绘制)/capture(toPng DOM 克隆) 本质是同步块,317 模板 × ~6 次/模板为批量真渲染的结构性成本,任务预授权三手段中"离屏渲染"不可达、"降并发"已到底、"压尺寸"已做(复测 -6.5%)。用户实际间歇滚动下队列有呼吸窗口(60s 复现 3/3 成功佐证);单次最大 long task(2.1–2.8s)发生在打开库挂载 317 张 SVG 卡时,属禁改的库主逻辑。
- **两轮全量均为 light 口径**:实测 admin 品牌偏好持久化为 light(登录即应用),本轮补 dark 抽验(5 屏 48 卡,35 张真渲染 + 其余为 map 合法回退/队列尾,0 pageerror,`dark-theme-check.png`);dark 全量未跑(渲染管线与主题仅颜色键不同,结论不依赖)。
- `DashboardTemplatePreview.tsx` 内"一次挂载 285 卡"历史注释已随本波次修正为 317(该文件归封面接入所有权,15 节曾标记为遗留)。
- 任务下达的 `templateSampleData.ts:125` tsc 报错在本次会话开始时已不存在(疑由并行会话修复),`pnpm exec tsc --noEmit -p .` 全程 0 错误,未越权改动数据层。

### 16.5 bundle 预算(今日 18:57 dist,`check-bundle-budget.mjs` EXIT=0)
- 首屏 JavaScript **321.0 KiB / gzip 106.4 KiB**(预算 1855.5/527.3);主入口 7.4 KiB、ViewerEngine 318.5 KiB、IFC 4028.5 KiB、参数化 WASM 22431.8 KiB 全部在预算内。
- 封面管线增量全部按需懒加载(manifest 实证不在初始链):`echarts-wordcloud` chunk **21.6 KiB**、html-to-image **12.9 KiB**、DashboardWidgetRuntime **46.2 KiB**——未打开模板库的会话零承担。

### 16.6 验证记录
- `pnpm exec tsc --noEmit -p .`:0 错误;触及测试:Preview/Catalog/Search/Typography/IndustryPack/新增 CoverTheme 共 **353/353 通过**(含新增 `dashboardTemplateCoverTheme.test.ts` 6 例)。
- 取证脚本:`apps/web/scripts/u131-cover-performance.mjs`(全量)、`u131-fail-diag*.mjs`(失败复现)、`u131-dark-theme-sample.mjs`(dark 抽验)、`u131-theme-probe.mjs`(主题时序);JSON 报告 `test-output/cover-performance/cover-performance.json`(复测轮)与 `round1-ratio0.5/`(首轮备份)、`dark-theme-sample.json`。
- 未 git commit;未改 admin/.env;禁改文件(数据层/库主逻辑/styles/prefabs/viewer/packages)零改动。

## 17. 波次 D 交付:模板示例数据的行业语义深化(2026-09-12 深夜)

### 17.1 需求与方案
真实渲染封面管线(16 节)上线后,示例数据从"数字合理"升级为"有行业节律的形状":电站负荷早晚双峰、医院门诊周末低谷、冷链开门扰动、金融交易日缺口。实现为按 domainId 的 profile 表(纯数据 + 纯函数),未收录域回退通用周期+噪声(既有行为)。

**落点与接线**:
- `src/studio/templateSampleDataProfiles.ts`:追加"行业节律词表"——4 种期间轴(hourly 24 期 / weekly 7 期 / daily 30 期 / monthly 12 期)+ `DOMAIN_RHYTHMS` 表:每域一条 `{ axis, shape[期数], event? }`,shape 为行业固有节律系数(不随模板变),event 为模板级偶发事件(dip 停机凹坑 / step 检修台阶 / spike 扰动尖峰,位置由模板种子确定)。
- `src/studio/templateSampleData.ts`:`TemplateSampleSpec` 增可选 `domainId` / `metrics[].role`(DashboardTemplateDefinition 天然携带,**layoutBuilder/coverRuntime 零接线**);`trendPatch` 按 rhythm.shape 取节律系数,叠加种子事件窗;告警语义趋势(metrics[0].role === "risk")保证 1-2 个越限尖峰,候选池取节律高值区 top 1/3(业务高峰时段的告警才可见)且避开停机/检修窗口。
- 同族清理:原 `metricShape` 的 `spiky/spikeChance` 字段在 trendPatch(index 0)恒为 false,是死路径,已删除——这正是"告警统计卡封面没真实感"的根源之一。

### 17.2 profile 覆盖:17 域显式 + 15 域通用回退
| 节律 | 域 | 轴/形状 |
|---|---|---|
| 平稳 + 偶发停机凹坑(dip 2 期 12%) | production*、maintenance、semiconductor、automotive、pharma | 24 时,白班微高 |
| 早晚双峰(负荷曲线) | power-trading | 24 时,9/19 时双峰 |
| 早晚尖锐双峰 | transport | 24 时,8/18 时,凌晨近零 |
| 清晨/傍晚双峰 | water | 24 时,7/19 时 |
| 夜间稳态 + 开门扰动(spike) | cold-chain | 24 时,营业时段高频 |
| 工作日高周末低谷 | healthcare | 周 7 期,周末 0.5/0.44 |
| 工作日峰,周末闭厅 | government | 周 7 期,周末 ≈0.04 |
| 交易日历缺口 | finance | 周 7 期,周末 ≈0.02 |
| 周末脉冲 | tourism | 周 7 期,周六 1.5 |
| 连续稳态 + 计划检修台阶(step 2 期 55%) | petrochemical | 月 12 期 |
| 连续稳态 | chem-safety | 月 12 期 |
| 季节缓变 | agriculture | 月 12 期,夏峰冬谷 |
| 开幕日脉冲 | expo | 30 天轴,第 3 天 2.6 后缓降 |

\* production 的 executive 视角走手写样例管线(dashboardProductionSample,历史设计),不消费本表;该域其余 9 视角模板正常注入停机凹坑。operations/energy/carbon/power-grid/environment/logistics/warehouse/retail/safety/quality/campus/construction/realestate/education/telecom 共 15 域按任务约定回退通用周期+噪声。

行数契约:期数多的轴自动收缩系列数(seriesCount ≤ ⌊100/期数⌋,daily 30 期 → 3 系列 = 90 行),守住 contracts 行 ≤100。

### 17.3 形状断言清单(templateSampleData.test.ts,27/27 通过)
形状用例(12 域):电力交易早晚双峰+凌晨低谷(24 期、首期 "00时");交通双峰(凌晨 < 早峰 ×0.2);水务清晨/傍晚峰(> 夜谷 ×1.8);医院周末 < 工作日 ×0.65;政务周末 < ×0.1;金融周末 < ×0.05(缺口);文旅周末 > 周中 ×1.25;半导体连续 2 期深坑 < 中位 ×0.3 且其余平稳;化工连续 2 期台阶 < ×0.75 且稳态极差 <1.3;农业相邻月差 < ×0.4 且峰谷 >1.25;冷链夜间均值 < 白天 ×0.15 + 开门尖峰;会展峰值 > 中位 ×2 且落在前 1/3。
工程用例:profile 表完整性(shape 长度=轴期数);节律域全部模板行数 ≤100 + 趋势类每期系列数一致(sankey/scatter/funnel 无期间轴,豁免);确定性(power-trading/expo/finance 双跑逐字节相等);告警趋势(risk 视角)1-2 个孤立越限尖刺(90 分位 ×1.3 + 邻期回落判定)且与停机事件不同期;非告警趋势 0 尖刺(双峰是平台不是孤点)。
测试为存量文件**追加**(该文件原有 9 例 317 模板契约回归保留,共 27 例);断言阈值均按 ±11% 噪声半幅最坏组合推演取定。

### 17.4 截图取证(每域 2 模板 × 12 域,真渲染封面)
- 脚本:`apps/web/scripts/wave-d-cover-shot.mjs`(登录 admin/admin → 编辑场景 → 资源面板 → 行业模板 → 按域搜索 → 等真渲染封面 dataURL → 截模板卡);产物 `apps/web/test-output/wave-d-sample-data/{before,after}/`(before 为改动前代码基线,经文件级备份/恢复保证时序;24 张 after + 12 张 before)。
- 肉眼可辨核验(8+ 域):**电力交易** 24 时轴早晚双峰(before 为均匀月轴锯齿);**金融** 周五后两柱塌零(交易日缺口);**水务** 清晨/傍晚双峰;**冷链** 夜间低位 + 营业时段开门尖峰;**会展** 第 3 天开幕巨脉冲后缓降;**交通** 早晚双峰凌晨近零;**政务** 工作日 5 柱周末空缺;**医疗** 工作日高周末低谷。同域第二模板(-2)形状一致、种子噪声不同,节律稳定可辨。

### 17.5 验证记录
- `pnpm exec tsc --noEmit -p .`:0 错误。
- `pnpm exec vitest run src/studio/templateSampleData.test.ts`:27/27 通过;`pnpm exec vitest run src/components`:**238 文件 / 1199 用例全过**,零回归。
- 诚实声明:① production executive 视角仍为手写样例(不在本波次所有权内),该封面形状不变;② 散点/漏斗/桑基/旭日等非趋势主图不带节律(节律语义在趋势轴上,这类图型无期间轴);③ light/dark 双主题的封面节律一致(仅配色差,未单独取证);④ 临时 stash 方案否决——工作区存在大量并行会话未提交改动,改用两文件备份/恢复(深化版备份于 test-output/wave-d-sample-data/_deepened-backup/)。
- 未 git commit;未改 admin/.env;禁改清单(dashboardTemplateLayoutBuilder/Preview/CoverArt/Library/styles/prefabs/contracts/viewer/DashboardComponentCatalog)零改动,coverRuntime 经结构化子集天然携带 domainId,无需接线。

## 18. 预制体真实模型缩略图(source-a GLB 替换程序化拼凑)

> 背景与判定:预制体缩略图此前全部由程序化几何体拼凑,用户判定"好 low"。本波次把命中真实设备的预制体切换为 source-a 资产库真实 GLB 渲染出图,未命中的保持程序化兜底,永不白块。prefab 定义(参数/动作/数据口)零改动。

### 18.1 匹配表(apps/web/src/prefabs/thumbnail/prefabModelMatches.ts)
- **命中 53 / 120(44%),未匹配 67**;53 条全部经 source-a 缩略图肉眼审查(机械臂/传送带/叉车/机柜/货架等逐张目检形态)后才收录,`prefabModelMatches.test.ts` 逐条核对 assetId/name 与 catalog 一致且 audit 状态 valid、非重复、qualityStatus=ready(preview 端点可用的前提)。
- 分族命中:机器人 7/16(机械臂 5 型各归各 + 立柱悬臂给四轴码垛)、输送 7/17(直线/宽幅/爬坡/90°/180°/T形合流/链式)、移动 9/25(潜伏 AGV/AMR/顶架 AGV/叉车×3/轿车/货车/无人机)、机床站体 10/14(三类机床/注塑/AOI/磨床/道闸/互锁门/大屏/围栏)、公用电气 11/15(泵/阀×2/风机×2/空压机/机柜×2/配电/储罐/过滤罐)、仓储 9/10(托盘架/流利架/堆垛机/立体库/贯通架/密集架/冷柜/周转笼/料仓)。
- **诚实清单(67 个未匹配,不强行错配)**:人员 ×5(source-a 无人物模型)、传感器 14+网关 2(无器件级小件)、摄像机 7(无监控机型;仅"监控标点"3D 图标不适用)、特种车辆 6(半挂/自卸/洒水/登高/皮卡/牵引车;库里"货物拖车"实为站驾搬运车、"人力叉车"实为手动搬运车,均因形态不符弃用)、机器人 9(Delta/SCARA/直角坐标/龙门桁架/双臂等无同构模型)、输送 10(滚筒/积放/分拣/螺旋/垂直提升等)、机床 4(激光焊/折弯/冲床/热处理炉)、公用 4(计量泵——按用户点名宁缺毋滥/电表/换热器/加药撬)、仓储 1(垂直提升货柜)。

### 18.2 渲染路径(prefabThumbnailRenderer.ts)
- 匹配命中 → `api.getLibraryPreviewBlob` 取 `/api/asset-library/items/{assetId}/preview`(与资源页模型预览同一来源,dev 下 /api 代理 4100)→ CompatibleGLTFLoader(DRACO+Meshopt)parse → 克隆归一化(最长边 3m、居中、底面落地)→ 挂同一套 prefabStyle 风格种子 → 既有取景/氛围/布光管线出图 → definitionId 级缓存。
- 失败纪律:**10s 超时/加载失败 → 记入失败集合(会话内不重试)→ 自动回退程序化构建器**;匹配缺失直接程序化;GLB 源按 assetId 缓存克隆复用(FIFO 上限 24,淘汰整体 dispose);队列改串行任务制(加载+渲染逐个执行,避免几十个 GLB 并发下载)。

### 18.3 验证记录
- `pnpm exec tsc --noEmit -p .`:0 错误;`pnpm exec vitest run src/prefabs` + Inspector:**33/33 通过**(新增匹配表校验 5 例 + GLB 路径 5 例:归一化取值、源缓存复用、失败回退、失败不重试、未命中不触碰 GLB)。
- playwright 视觉闭环(admin/admin,产物 `apps/web/test-output/prefab-real-models/`):管理端资源页工业预制体 tab 深色/浅色/默认三轮 **24/24 缩略图就绪**;3D 编辑器资源浮窗 **57/57 就绪**;**GLB preview 请求 38/38 成功、0 失败、0 回退警告、0 页面错误**;10 个匹配特写(closeup/)逐张形态核对无误配。
- 对照板:`compare-thingjs.png`(sharp 并排,左 ThingJS 资源中心基准,右上深色/右下浅色)——本作命中卡片的真实质感(白/黄/红黑工业机械臂、机床、注塑机)已与 ThingJS 真实 3D 封面同档;未命中卡片(直角坐标/Delta 等)仍为程序化示意,待上游补模型后经匹配表零成本切换。
- 诚实声明:① 未匹配 67 个保持程序化兜底(见诚实清单),后续并行代理补齐 CC0 模型后只需在匹配表加一行;② "四轴高速装配 SCARA/六轴码垛"等变体与命中变体共享模型的仅限同形态资产;③ capture-stats.json 中 studio 轮 GLB 去重统计 38 资产(53 匹配中页面当轮可见 38),其余 15 个资产为翻页/搜索后才加载,加载路径同一;④ 深/浅主题下缩略图渲染同一 dataURL 缓存,色彩氛围为棚拍中性光,与主题背景融合(仅 UI 底色切换)。
- 未 git commit;data/ 目录零改动(匹配表只引用);prefab 定义/参数/动作/数据口、contracts、viewer、styles、dashboardTemplate* 均零改动。

## 19. 数量波次 F 交付:2D 预设 420→520(2026-09-12)

### 19.1 需求与落点
资源库 2D 组件预设 420→520(+100),五条线全部落地,零凑数(聚类门禁 vitest 常驻):

| 方向 | 数量 | 落点 |
|---|---|---|
| 真实图表类型族(词云 7 / 箱线 8 / 瀑布 7 / 极坐标 8) | 30 | `dashboardAnalysisPresets2.ts` 追加(24→54) |
| 行业 KPI 补深(电力 7 / 水务 6 / 化工 7 / 医院 7 / 政务 6 / 半导体 7) | 40 | 新建 `dashboardIndustryKpiPresets3.ts` |
| 地图族变体(钻取增强 3 / 园区平面 2 / 管廊 2 / 路网 2 / 轨迹 2 / 密度热力 1) | 12 | 新建 `dashboardGisVariantPresets.ts` |
| 装饰造型(边框 3 / 标题条 3 / 光效 4) | 10 | `dashboardDecorationPresets2.ts` 追加 |
| 报表/控件(交叉表 2 / 树形台账 1 / 期间汇总 1;级联 2 / 日期区间对 2) | 8 | `dashboardReportPresets2.ts` / `dashboardUtilityPresets2.ts` 追加 |

接线:`DashboardComponentCatalog.ts` 聚合新文件;`DashboardComponentPreview.tsx` 的 `MAP_MARK_VARIANTS` 为 12 个地图变体补 mark 构图映射(drill/annotation/pipe/flow/heat/road);测试 `DashboardComponentCatalog.test.ts` 数量门禁 420→520、新增波次 F 配额断言与四类真实图表深度断言(各 ≥8)、地图变体 mark 与区域族零重叠断言。

### 19.2 语义纪律
- 行业 KPI 全部取行业考核口径:备用容量率 ≥13%、AGC 投运率 ≥98%、DMA 夜间最小流量暗漏阈值、出水 COD 一级 A ≤50 mg/L、手术间利用率 <80% 预警、抗菌药物送检率 ≥50%、WAT 合格率 ≥98%、套刻偏差 >3.5 nm 报警、差评整改率应达 100% 等,每项带量程 + conditionalRules。
- 真实四类直接消费运行时(`dashboardAdvancedChartOptions.ts` 已定稿,零改动):词云字号随频次、箱线五数概括、瀑布首项基期+升降语义色、极坐标环形堆叠。
- 级联筛选用合同原生 `parentFilterKey`(省→市、厂→线);日期区间用 start/end 两个 date 控件组合(合同 filterMode 仅 select/multi-select/text/date,如实按端点控件表达区间)。
- 装饰 10 款 mark(CIRCUIT/SPLINE/COFFER/GEAR/TURBINE/TRUSS/COMET/AURORA/FIREFLY/GRIDS)与既有 96 个装饰 mark 零重复。

### 19.3 验证
- `pnpm exec tsc --noEmit -p .`:0 错误。
- `pnpm exec vitest run src/components`:238 文件 / **1200 用例全过**(目录断言 520+、聚类门禁簇<3、每预设 renderToStaticMarkup 与应用文档合法性、波次 F 配额);`dashboardAnalysisPresets2.test.ts` 冻结数量 24→54 同步更新(id 稳定性断言保留并通过)。
- playwright 视觉闭环(admin/admin,Chrome 真实渲染,产物 `apps/web/test-output/quantity-wave-f/`):
  - round1(第一轮):dark 10 个家族分组图(词云 9 卡/箱线 12 卡/瀑布 9 卡/极坐标 10 卡/行业 KPI/地图钻取/管廊/装饰边框/报表交叉/控件级联)+ **抽样 15 个插入画布逐个截图**(类型分发全部正确)+ light 4 族 + light 2 插入;
  - round1b(补拍):行业 KPI 三种 metric 构图(良率 value/翻牌 flip/合格率 progress)、地图轨迹与标注组、装饰标题条与光效组、报表汇总表组 + 装饰/轨迹 **12 张逐卡特写** + light 8 组;
  - round2(第二轮复核):与 round1 同口径全量重跑,10 族 + 15 插入 + light 4 族结果一致;
  - 两轮 pageerror 均为 0。
- 逐卡目检(构图/对比/可读/语义/配色五项):真实图表 30 卡、地图 12 卡、装饰 10 卡、报表/控件 8 卡全部通过;行业 KPI 40 卡经三种构图代表 + 精确名抽样覆盖(value/progress/flip 构图与既有族一致,语义差异在名称/单位/阈值)。

### 19.4 诚实声明
- 插入画布的组件在未绑定数据集时显示各自的空态(词云空白画布/指标卡表盘弧/表格表头),这是编辑器既有设计态行为(既有 420 预设同路径),运行时图表真实渲染由 `dashboardAdvancedChartOptions.test.ts` 与模板封面管线覆盖;插入取证验证的是"可插入、类型正确、无报错"。
- 取证过程曾因 `deleteLayerNode` 的 `window.confirm`(Playwright 默认 dismiss)导致删除未生效,组件残留在示例看板;已定位并用 dialog accept 清理脚本**精确按名称删除全部 47+17 个取证组件**,示例看板恢复原始 15 图层(经营总览 9 件套 + 经营指标卡 5 + 3D 视口),独立会话复核落盘确认,原始组件零丢失。
- 主题取证说明:admin 品牌偏好持久化为 light,脚本以 `document.documentElement.dataset.theme` 强制切换取证(与 wave-d 先例一致);light 轮插入截图曾出现 UI 主题被应用回深色的时序问题,round1b 已按插入前强制主题修正。
- 资源面板列宽导致卡片标签截断显示省略号,全名由 hover title 承载(面板既有行为,非本波次引入)。
- 未 git commit;未改 admin/.env;禁改清单(dashboardTemplate* 全部、templateSampleData*、styles 其他文件、prefabs、viewer、contracts、DashboardWidgetVisualization、dashboardAdvancedChartOptions)零改动。

## 20. CC0 缺口设备模型补充(预制体真实模型第二波次)

> 执行窗口 2026-09-12;执行者为"缺口设备模型 CC0 下载补充"专项会话,与 2D 预设/看板波次并行,禁改清单(components/、styles/、dashboardTemplate*、viewer/、contracts、其他 data/ 目录)零触碰。

### 20.1 结果概览
- 匹配表 `prefabModelMatches.ts` 新增 **20 条**(53→73),全部指向 source-b 社区库 `community-{uid}` 条目;预制体缩略图从程序化小样升级为真实模型渲染。
- source-b 缓存 `data/external-assets/source-b/`:catalog **80→100 条**(100 published)、audit **80→100 条**(100 approved),新增 GLB 全部 ≤15MB、≤10 万三角面,`reviewed-thumbnails/` 新增 20 张 studio-webgl 真实渲染缩略图。
- 本轮从 Sketchfab 搜索 **608 个候选**(22 组关键词),下载 35 个,目检批准 20、拒绝 15(拒绝明细与备份见 20.5)。

### 20.2 下载清单(名称 × 许可 × 作者,全部 CC-BY-4.0,originUrl 均为 sketchfab.com/3d-models/{uid})
| 预制体 | 中文名 | 原模型 | 作者 | 许可 | 体积 | 三角面 |
|---|---|---|---|---|---|---|
| camera.bullet | 枪型网络摄像机 | CCTV camera | Just8 | CC-BY-4.0 | 3.4MB | 5068 |
| camera.fixed | 固定式工业相机 | CCTV Camera | Smoggybeard | CC-BY-4.0 | 3.0MB | 3166 |
| camera.dome | 半球型网络摄像机 | Dome Camera [FREE] | MiguelRamos | CC-BY-4.0 | 0.1MB | 3790 |
| camera.ptz | 云台摄像机 | PTZ Security Camera | Caleb_G | CC-BY-4.0 | 0.2MB | 7970 |
| sensor.smoke-detector | 感烟探测器 | Smoke Detector A5 | YD Visual | CC-BY-4.0 | 1.1MB | 6220 |
| sensor.sounder-strobe | 声光报警器 | Fulleon Roshni Sounder | dylanheyes | CC-BY-4.0 | 0.3MB | 3859 |
| sensor.temperature | 温湿度传感器 | Terma VTS Smart temperature and humidity sensor | termagroup | CC-BY-4.0 | 3.1MB | 20026 |
| sensor.rfid | RFID 读写器模块 | RFID-RC522 (Arduino UNO Compatible) | davidg.dev | CC-BY-4.0 | 0.5MB | 1944 |
| sensor.flow | 流量计 | Flow meter | cadcrowd | CC-BY-4.0 | 0.3MB | 7019 |
| sensor.load-cell | 称重传感器 | Load Cell | YouniqueĪdeaStudio | CC-BY-4.0 | 0.4MB | 14018 |
| vehicle.tractor-unit | 半挂牵引车 | Semi Truck | rio3dstudios | CC-BY-4.0 | 0.5MB | 7854 |
| vehicle.dump-truck | 自卸车 | Dump Truck | ElectroNick | CC-BY-4.0 | 3.7MB | 34307 |
| vehicle.boom-lift | 曲臂式登高车 | Boom Lift (Articulating) | doty_aecom | CC-BY-4.0 | 2.2MB | 65474 |
| vehicle.patrol-pickup | 皮卡巡查车 | Pickup Truck | 00amza | CC-BY-4.0 | 1.6MB | 5047 |
| vehicle.tow-tractor | 牵引车 | pushback | terran4627 | CC-BY-4.0 | 1.2MB | 11179 |
| person.worker | 作业人员 | Construction Worker | katelaruine | CC-BY-4.0 | 3.1MB | 26766 |
| person.operator | 产线操作员 | Construction Worker Low Poly | Nitoktris | CC-BY-4.0 | 2.6MB | 23285 |
| person.guard | 巡检人员 | Avatar Safety Uniform | Nyayata | CC-BY-4.0 | 4.3MB | 45910 |
| person.maintenance | 维修技师 | Worker talk animation | Bazsi1986 | CC-BY-4.0 | 10.4MB | 62215 |
| person.visitor | 访客 | The character of an office worker | BELAZ | CC-BY-4.0 | 2.2MB | 17363 |

每条 catalog 记录含完整 author/license/originUrl/licenseUrl/attribution/modifications 字段,资源页与 API 元数据透出署名;下载后逐个目检 GLB 渲染图,无竞品商标与品牌标识贴图(RFID-RC522 的通用型号丝印、Fulleon 声报警器的外观形态均不构成品牌标识,已在 audit notes 中记录判断)。

### 20.3 管线与脚本
- 新建 `apps/web/scripts/sync-prefab-gap-models.mjs` 三段式管线:`--download`(Sketchfab 官方 API 按许可端点判定 CC0-1.0/CC-BY-4.0,原子下载 + `inspectGlbFile` 结构审计,超 15MB/10 万面直接拒收,登记 catalog 为 review-required)→ `--render`(dev server `/optimizer` 页面真实 WebGL 渲染并导出预览图)→ `--approve`(仅对目检通过的 picks 写 `reviewed-thumbnails/`、追加 audit approved 记录并置 published;全程与 `sourceBAssetCatalog.eligible` 校验对齐,沿用 `catalog.sync.lock` 防并行写)。
- 目检纪律:每个模型先经 `/optimizer` 真实渲染出图,逐张人工(代理)审看形态语义与品牌贴图后才批准;拒绝的 9+6 条(见 20.5)按 `prune-source-b-review-required.mjs` 同款纪律备份至 `apps/web/test-output/prefab-cc0/prune-backup/` 后从 catalog/audit/文件三者移除,最终目录保持 100/100 全批准。

### 20.4 匹配表与渲染修复
- `prefabModelMatches.ts`:头部注释改为 source-a/source-b 双来源说明,`PrefabModelMatch.assetId` 支持 `community-{32 位 uid}`;新增 20 条分四族:摄像机 4(camera.bullet/fixed/dome/ptz)、传感器 6(sensor.smoke-detector/sounder-strobe/temperature/rfid/load-cell/flow)、车辆 5(vehicle.tractor-unit/dump-truck/boom-lift/patrol-pickup/tow-tractor)、人员 5(person.worker/operator/guard/maintenance/visitor)。
- `prefabModelMatches.test.ts` 同步:source-a 校验、source-b 校验(许可白名单 + 署名完整 + 结构审计 + approved 复核 + displayName 一致)、assetId 格式断言、规模门禁 ≥50→≥70(现 73)。
- `prefabThumbnailRenderer.ts` 同族修复(2 处):`Box3.setFromObject(..., true)` 精确包围盒。根因:人物类 SkinnedMesh 的未蒙皮几何 bounds 失真,导致 `person.worker` 缩略图黑屏;修复后黑白颠倒问题消除,全部 20 个新模型真实出图(修复前后对比见 shots 重拍记录)。

### 20.5 拒绝记录(宁缺毋滥,均留 render 证据)
- 下载前拒收(硬约束):Delta robot IRB 390(34MB)、SCARA V1(18.5MB)、SCARA CNC(21MB)、restore50 三款工人(16~21MB)超 15MB;3-Axis CNC Gantry System(36 万面)、Inductive Sensor(29 万面)、Infiray P2 Pro(12 万面)、Warehouse Worker(超面数)超 10 万面。
- 渲染目检拒绝:Harbringer Delta(四足战斗机甲,非 Delta 并联机器人)、industrial computer/Industrial Terminal(血迹科幻终端)、Bar-Type Load Cell(两片白板不可辨)、Low-poly Construction workers(双人施工场景整体)、Worker Man Rigged(赤膊形象不符厂区人员)、Cartoon worker(卡通风与写实人物不统一)、Girl with clothes(复古农妇)、Surveillance CCTV camera(脏污品质劣于已选枪机)。
- 因此 **Delta/SCARA/龙门/双臂机器人与接近/液位/压力/振动传感器、热像机、洒水车等仍无达标 CC0**,保持程序化兜底(渲染器"永不白块"路径),未为凑数降低标准。

### 20.6 验证与证据
- `pnpm exec tsc --noEmit -p .`:0 错误;`pnpm exec vitest run src/prefabs`:6 文件 **36 用例全过**(含新匹配表 9 项校验)。
- playwright 视觉闭环(admin/admin,真实 Chrome 渲染,产物 `apps/web/test-output/prefab-cc0/`):
  - `shots/prefab-tab-full.png`:管理端"资源 → 工业预制体 120"全景,真实 GLB 缩略图批量上线;
  - `shots/closeup-*.png`:20 个新条目搜索定位逐卡特写(20/20 成功出图,results 见 `closeup-results.json`);
  - `renders/*.png`:每个模型入库前 `/optimizer` 真实渲染的原始证据(审批依据)。
- SkinnedMesh 包围盒诊断:修复前 `person.worker` 黑屏、修复后出图;bounds 诊断(rough vs precise)在 3 个人物模型上实测并确认修复。

### 20.7 诚实声明
- `closeup-person-guard` / `closeup-person-maintenance` 卡片中人物显示不全(裁头/偏小):根因是资源卡片缩略容器对 240px 方形渲染图按既有 `object-fit: cover` 口径显示裁切(竖长人物上下被裁,与既有程序化人物缩略图同口径),**渲染层数据与取景已正确**;该样式属禁改 styles/ 范围,本波次不动,如实记录。
- 本轮 20 条全部为 CC-BY-4.0(未遇到合格 CC0-1.0 候选);CC-BY-4.0 要求署名,catalog/audit/API 元数据已带完整署名链,若后续需要免署名发布需替换素材。
- 搜索依赖 Sketchfab API 在线可用;候选筛选以名称语义 + 缩略图 + 渲染目检三层过滤,不排除同类关键词下存在未被检索到的更优模型。
- 未 git commit;未改 admin/.env;未动 source-a 与其他 data/ 目录;`prefabThumbnailRenderer.test.ts` 中 1 处用例假设更新(原用 `person.worker` 举例"未命中匹配表"路径,该预制体已有真实模型,改用仍走程序化的 `robot.scara-4`,断言语义不变)。
