# PostgreSQL 填报首驱动 · 2026-09-08

## 已完成

- 向后兼容保留 REST `version:1 / recordPath / fields`；新增 PostgreSQL `version:2 / kind / schema / table / primaryKey / versionColumn / fields`。请求、快照、路径、权限和前端状态机不另起一套。
- 数据中心管理员可配置目标表、主键、版本列及字段规则。未改变的配置不随保存重复发送；显式关闭发送 null。普通编辑不能改变目标配置或其连接；viewer 禁写、项目隔离保留服务端校验。
- 真实单列主键、非空基础整数版本列、字段类型与生成列在数据库目录核验。主键、版本列、内部版本别名不能作为填报字段；标识符严格校验后双引号引用，所有记录 ID/版本/值独立参数绑定。
- 同一 Client 事务内按主键锁行，条件 `pk + revision` 更新且版本加一；零行冲突、多行拒绝/回滚，字段或数据库约束失败不递增版本。COMMIT 回执断开返回 unknown，不自动重试；前端复用既有确认、保稿、409 比较与未知结果核对。
- 不将 SQL 文本/URL/临时凭据交给浏览器填写为写回请求；仅复用已保存连接的环境凭据。SQL 驱动不回退平台元数据库配置。超过 JavaScript 安全整数或十进制往返精度的值明确拒绝，避免 numeric 静默截短。

### 依赖与官方依据

新依赖 `pg 8.23.0`、开发类型 `@types/pg 8.23.1`，均已核对 registry 当前版本并锁定。原项目 PostgreSQL 预览是 psql 整段只读查询，没有可复用的参数化业务写驱动。采用 [node-postgres 参数化查询](https://node-postgres.com/features/queries) 与 [同一 Client 事务](https://node-postgres.com/features/transactions) 的官方模式；没有绕过既有预览只读门禁。

### 聚焦验证

- API 4 文件 19 项通过，其中真实 PostgreSQL 8 项：参数化字符串注入反例、同版本并发仅一成功、CHECK 失败回滚、数据库权限、路由 viewer/跨项目、无真实 PK/可空版本拒绝、trigger 不递增版本回滚、COMMIT 回执截断、精度反例与读回。
- 合同 23 项通过：REST 兼容、系统 schema/非法标识符/主键版本冲突/内部别名拒绝。
- Web 配置、session、草稿缓存 3 文件 15 项通过；API、Web、contracts 类型检查通过；门禁语法及 diff 检查通过。
- 数据库实测使用 `apps/api/scripts/isolatedPostgresFixture.mjs` 在测试目录自建 PostgreSQL 18 临时 cluster 和随机端口；测试结束停止，仅保留证据。COMMIT 故障是协议代理拦截真实数据库已执行的回执，不是伪造数据库成功。
- r48 测试工具可移植修补：优先显式 `BIM_WRITEBACK_PG_BIN`，否则 Windows 标准安装路径 / PATH、POSIX PATH 查找 initdb、pg_ctl、postgres。普通集成测试缺依赖时明确跳过并提示，真实浏览器门禁缺依赖时明确失败，不连接正常数据库兜底。本机 PostgreSQL 18.3 的 8 项再次全部实跑通过，工具依赖检查另 2 项通过；显式无效工具路径验证得到 8 skipped，不计为通过。

### r47 浏览器证据

- 主线程统一根构建 r47 退出 0；本批未自行构建。Web index SHA：`e29bfea965b034a6a89ba25c3bb549b5d64d859c58b7a530dc70736afc2a158f`。
- `test-output/codex-2026-09-05/postgres-writeback-ui-fkyiBp/report.json`：两轮 dark 1440 / light 980，4/4 通过；亲审两轮配置、冲突、未知结果截图共 8 张。SQL 新配置的模式/表/主键/版本字段均完整可读，校验规则按需展开，保留原金色令牌。
- 增强门禁 `test-output/codex-2026-09-05/postgres-writeback-ui-Uo8y3M/report.json`：同构建两轮 4/4，额外实际点击“运行查询”，旧 psql 只读路径返回 7 并同步 2 字段，然后真实写入/读取 12；刷新保稿 25；外部写 30 后 409 保稿并显式再次确认；数据库 CHECK 拒绝 95、版本不变；真实 COMMIT 已写 40 但回执断线返回 unknown，刷新后显式读取核对而不重放；viewer UI 与直接 API 均禁写。亲审新增两轮写入/冲突/未知 4 张。
- 每组只有预期注入 409/422/502，其他 console/page 错误及警告为 0。数据库为本机 PostgreSQL **18.3**，隔离 cluster `postgres-writeback-fO5Ytm` 已停止；无正常业务库连接。
- 首次 `postgres-writeback-ui-C7BEeq` 因 SQL textarea 的嵌套 label 含默认内容，门禁 exact 名称未命中；已按真实 SQL 标签选择 textarea。该次没有产品错误，也未放宽业务断言，失败证据保留。

### r48b 同族修补与复验

- 数据中心现将确定成功的写回结果交给既有预览查询刷新；刷新不会重复保存数据集配置，保留未变的 writeback 引用，避免已写入状态被会话重建抹掉。查询按项目/数据集/序号丢弃过期回包；失败由既有表单独立提示并提供只读“刷新视图”，不重新 PATCH。
- 预览表头/单元格、空态、成功条与底部字段状态改用 `base.css` 令牌，局部作用域不影响其他页面。聚焦 4 文件 21 项及 Web 类型检查通过。
- 主线程 r48b 统一 build/typecheck 退出 0；全量 Web 434 文件 1799 项、API 591 项通过。Web index SHA：`8431ee73719da7eafa5ec864a152fcfb410ee5669c500b7f491bfcec7758c1ed`。
- SQL `test-output/codex-2026-09-05/postgres-writeback-ui-ARCw1u/report.json` 两轮双主题 **4/4**：真实写 12 后无需刷新页面，预览显示 12；409/422/COMMIT unknown 原语义不退化；最后真实写 41 且 revision=6，预览注入 503 时仍显示原快照 40，独立提示“记录已写入，视图刷新失败。”；显式只读重试后预览 41，revision 仍为 6、数据集配置保存次数不增加。
- REST `test-output/codex-2026-09-05/dataset-writeback-q9g0lF/report.json` 两轮双主题 **4/4**，同样断言写 12 后预览 12；刷新保稿、409、未知结果不重放与 viewer 禁写全部保留。两套最终门禁均仅记录预期故障注入请求，其余 console/page 错误及警告为 0。
- 浏览器实测预览表头/单元格对比度：深色 **13.74 / 8.22**，浅色 **14.45 / 8.26**，均高于 4.5。亲审 SQL 8 张（两轮写入、失败、重试、配置、冲突、未知）及 REST 4 张（两轮配置、冲突、核对），双主题 1440/980 无新增横向裁切。
- 初次 r48b `postgres-writeback-ui-emImvZ` 已走通首组业务，但门禁自己的 Canvas 对比度读回触发浏览器性能警告，严格零警告断言失败。仅为测量 Canvas 加 `willReadFrequently` 后完整重跑；不屏蔽警告、不改产品、不重建 bundle，失败产物保留。
- 隔离 PostgreSQL cluster `postgres-writeback-nkUnmb` 已停止；没有连接或修改正常业务库。

### 截图自评与同族发现

遵循 `design-taste-digitaltwin`：帆软的数据配置流程、西门子的紧凑分组与明确状态，令牌来自 `base.css`；非新增竞品实机性能对比。下表按本批实际截图，不将局部业务通过扩大成全站 Kimi-95。

| 维度 | 自评 | 依据 / 待办 |
| --- | --- | --- |
| 布局构图 | 9 | 1440 三栏、980 重排，新 SQL 目标字段无裁切 |
| 令牌一致性 | 9 | 新配置与预览表/成功条统一令牌，浅色暗底残留已修复并实测对比度 |
| 排版 | 9 | 新四项短标签单行，冲突表与操作完整 |
| 交互状态完备 | 9 | 校验、真实 DB 拒绝、409、未知、恢复、viewer 均验证 |
| 动效质量 | 不适用 | 本批无新增动画 |
| 3D 渲染质量 | 不适用 | 本批不改 3D |
| 信息设计 | 9 | 确定写入同步刷新；刷新失败分别呈现已写结果与旧快照，提供只读重试 |
| 反馈即时性 | 9 | 成功/失败即时可见，未知不伪装成功或允许重复写 |
| 响应式与主题 | 9 | 本批 1440/980 双主题复验通过；480/800不在本批证据中，不扩大为全站验收 |
| 语义与文案 | 9 | SQL 复用原“填报”语义，规则帮助在悬浮/展开项 |

**同族闭环**：`Uo8y3M/r2-light-written.png` 所见“表单 12、预览 7”及浅色低对比已由 r48b 修补并用 SQL/REST 双入口证实。未知结果仍保留旧预览，不自动按成功刷新；这是保守结果语义，不是写后刷新回归。

## 本轮待办

- 正式可发布画布表单、其他 SQL 驱动、其余全目标待办不因首驱动完成取消。

## 明确排除

不恢复已暂停的匿名写回/统一语义治理、AskData、协作。admin/admin、`.env`、正常 PostgreSQL/MinIO 拓扑和原业务数据不改。不自行构建共享 dist、不提交、不 push。

## 项目级后验收

客户数据源需真实单列主键和非空整数版本列，所有写入方遵守递增约定；本批不自行变更客户表结构。不将已验证的单记录 PostgreSQL 18 流程冒称多数据库、多行事务或任意业务兼容。客户 TLS/权限、RLS/触发器、精度范围、业务约束与部署仍须按真实源核验。
