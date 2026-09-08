# 行业包与填报接续 · 2026-09-08

最终构建增量：r46 Web build 退出0；r45根typecheck/2142源文件体量和Web427文件1767测试退出0。r46 `dashboard-readability-I7YKEA` 两轮4/4、`dashboard-print-pdf-F6Rd6T` 两轮双主题8份实际PDF通过，主线程亲审横/纵版百分比完整。r44制造原包 `industry-packs-azEGlR` 回归4/4。二维写回与失败隔离证据 `dataset-writeback-gtKDm8` 4/4、原数据中心 `dataset-writeback-rKezmO` 4/4。后文r44 PDF失败保留为真实发现记录，已由r46修补闭环；素材卡最终截图证据见独立审核报告。

素材卡补充：r46 `source-b-library-937xwx` / `source-b-library-aP9QWG` 各4/4，图片与悬浮几何无裁切、七项实际导入与许可/hash检查通过。主线程亲审首轮浅980总览和第二轮深1440悬浮后总览。第二轮首次刷新截图偶有图片尚未绘制、悬浮后恢复，尚未证明是纯测试时机；**首次绘制稳定性仍是本轮待办**，不因尺寸修补通过而隐藏该现象。原GLB/PNG未改。

## 已完成

- 新增仓储履约运行包五页：履约总览、库存可用性、波次拣选、装车发运、异常闭环。独立业务样本按库区关联；库存件数、托盘、装车箱数不混算。总览待拣/待发/未结异常与逐单台账核对，拣选和装车数量分别守恒。来源、事务、撤销、筛选隔离复用既有行业包实现。
- 目录改为逐包校验：缺字段、错误类型、坏筛选值、重复 ID 隔离，不再让一个坏包在模块加载时拖垮整个二维工作区；正常目录不额外显示说明。
- `gate-logistics-pack.mjs` 在 r44 两轮 dark1440/light980 共 4/4：五页预览、整包导入/撤销/重做、无效改数拒绝、有效改数、保存刷新、B 区五页联动、各页真实 CSV 列、发布匿名刷新与 C 区库存读取。证据 `test-output/codex-2026-09-05/logistics-pack-Xe9gRH/report.json`，产品控制台错误与驱动警告均 0。主线程亲审 r1 深色库存与 r2 浅色总览；r43 两轮图也已审。
- r44 Web build 与全量测试退出 0：426 文件、1764 测试。r43 根 typecheck/source-size 通过，2140 源文件无超过 800 行；后续新增图表/素材 CSS 修补另需最终统一复验。
- 正常 `pnpm studio check` 仍为 web 健康，API4100/Web5173，PID48008。未改正常账号、存储、原场景，未 push。

## 本轮待办

- 当前为两个已接通的五页业务包、共十个深化页面；**不是十个完整行业深度包，也不是三百页面达标**。旧 120 个模板 ID 保留，不将布局组合或改名算新增业务深度。
- 匹配 3D 资产尚未接线。新审核仓库可作外观候选，不代表有可钻取 BIM 楼层；制造包同样需要明确匹配已审资产。
- 素材累计 7 项批准、159 项未批准：其中本批已检查但未通过 8 项，另 151 项仍未视觉审核。详情见 `source-b-visual-review-verification-2026-09-08.md`。
- 二维作者填报已接真实 REST 写回并在确认成功后刷新指标；正式画布填报组件、SQL 写入仍属全目标本轮待办，不能归入排除项。详情见 `dashboard-writeback-entry-verification-2026-09-08.md`。
- 模板字体与图表标题/单位改进详见 `dashboard-template-readability-verification-2026-09-08.md`。r44 PDF 自动检查通过但纵向饼图标签亲审未过；正在修复，不用脚本通过冒充视觉完成。
- 整数业务计数目前沿用通用两位小数表格和自动数值刻度，后续须补业务格式精度；相机、仿真/AI及其余当前有效队列仍保留。

## 设计复核

依据 `design-taste-digitaltwin` 的 FVS 等比画布/数值规范与西门子业务信息层级；这是既定内部设计基准，不声称本次新做外部竞品调研。沿用 `base.css` 令牌。两轮局部自评：布局9、令牌9、排版9、交互状态9、信息设计8（计数精度待补）、反馈9、响应式主题9、语义文案9；动效与3D不属本包页面验收，不评分。未达到整体极致门槛，不宣称全项目完成。

## 明确排除

协作、GPT 接入、旧自动化恢复、已暂停统一语义治理与专项性能不恢复；admin/admin、`.env`、PostgreSQL+MinIO及原资产不改。

## 项目级后验收

示例业务流程不能代替客户 WMS 数据质量、真实作业调度或设备控制验收。

## 下一批实现入口（已只读核对，不是已实现）

- SQL：`dataIntegration.ts` 已有 PostgreSQL/MySQL/Oracle 预览，`dataIntegrationPreviewAdapters.ts` 有 SQLServer；`dataIntegrationHelpers.ts` 的 PostgreSQL 调用为 psql 整段语句，不能绕过只读门禁来冒充参数绑定。API 已有 mysql2/oracledb/mssql，未有 pg。`dataWritebackService.ts` 与保存配置路由仍明确仅 HTTP；`contracts/src/dataWriteback.ts` 只有 REST recordPath。
- 复用当前权限、字段校验、opaque version、确认/冲突/未知/草稿状态机；新增 SQL 受控目标合同及独立驱动适配。表/列来自服务端保存的白名单，值必须参数化，主键+版本条件 UPDATE 原子执行；多行回滚、零行区分404/409，提交回执未知不自动重放。首驱动必须真实隔离数据库验证，不拿 REST 测试桩冒充 SQL。不可修改正常 PostgreSQL 配置或数据。
- 二维填报体验：目前写41已确认但视图查询503时保留旧值25，写状态正确；hook未向表单回传刷新失败，需补独立可见提示与显式重试。不得把刷新失败改成写失败或自动再次提交。再处理窄窗字段面板与填报面板的协调、相邻条件格式浅色暗卡和按钮断行。
