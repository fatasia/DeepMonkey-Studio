# DE26/G02 · 筛选器与页面外观编译(方案先行,实现前冻结)

日期:2026-09-17。状态:**切片 1–3 已实现；Native/组合宿主消费与视觉闭环待 G01**。依赖:G01(组合宿主矩阵)。

## 现状(源码实测)

- 合同已有完整筛选器配置:`DashboardWidgetConfig.filterMode(select/multi-select/text/date)`、`filterMatch(exact/contains)`、`filterField`(跨页发布参数)、`parentFilterKey`(父参数禁用)、`options`(packages/contracts/src/dashboard.ts:200-207)。
- 编译现状:`dashboardWidgetContent.ts` 无 filter 分支 → 落入 "组件类型 filter 尚无内容编译器",`contentCompiled=false`(chromeOnly 降级)。
- 运行时:发布回放 `filters={}` 静态(PublishedApplicationRoot),作者回放走 `session.state.setFilter`。

## 冻结的切片边界(实现按此三步,每步独立可验收)

### 切片 1:筛选器静态 chrome 编译
- 内容框 = 标题区 + 选项列表(每选项一行,选中项高亮条);复用 `lowerDashboardText` 既有文字通道,无新字体管线;
- compiledFields:`widget.options`、`widget.filterMode`、`widget.title`、选中态索引;
- 边界:options 空数组 → 编译空容器(合法);options 超 16 项截断并登记 reason;长中文溢出内容框 → 裁剪 clip(与表格同语义);parentFilterKey 存在 → 报 disabled 态原因。

### 切片 2:命中路由
- 选项行 hit 区域 → `pointer/key → hitId → command`(白名单动作:setFilter);hitId = `node.id:option:<index>`;
- 切换选中 → 参数发布 → 同页表格/图表按 `filterField` 过滤(运行时消费归 G01 宿主,本切片提供 command 形状)。

实现:`dashboardWidgetContent.ts` 为首 16 项生成稳定 option hit；`dashboardFilterHitCommand.ts` 只允许
pointer/Enter/Space 生成 `setFilter`，并拒绝外来 node/key、越界、隐藏、父参数未就绪和非 select。
未选中行使用 alpha-zero filled path；这是既有 Deep2D path hit 合同（命中按 fill 几何与 command opacity），
当前没有独立 hit-only primitive。

### 切片 3:筛选数据流贯通
- `dataset → transform → widget property` 链上 filterField 生效;空结果态(表格显示空态,图表显示空轴);发布回放 readOnly 下 filters 从冻结快照初始。

实现:复用 `ApplicationPlaybackState.setFilter` 与 `applyDashboardFilters`，不新增状态容器。公开发布页从冻结
文档的可见 select 控件首项确定性建立运行初值；`全部/All`、隐藏与非 select 不注入。`filterField` 支持
嵌套路径，缺字段零匹配；父值 null/空串/空数组/全部均不激活子筛选；表格零行复用现有空态，图表保持
空分类/空系列。发布合同尚无作者 transient filters 字段，因此不伪造未冻结的作者态。

## 本轮验证

- Web typecheck 通过；合并聚焦 5 文件 34 项通过。
- 边界覆盖:稳定 hit identity、16 项截断、pointer/键盘白名单、外来/越界/隐藏/父门禁、嵌套字段、
  缺字段、contains/exact、父筛选清空、发布初值逆序父子、隐藏控件、表格空态与图表空轴。
- 未改 CSS/令牌/布局；未启动浏览器双轮截图，Native/组合宿主尚未消费 `setFilter` 命令，故 G02 整卡
  保持`本轮待办`，不得把纯合同与 Web 数据流测试冒充 T+N+W+GPU+WEB 全验收。

## 明确排除(不许混入)

- date/multi-select 模式首切片只编译外观,行为归切片 3 后续;
- 不新增字体管线;不改 ChartIR;不碰登录/账号/存储。

## 验收(全切片合拢时)

- 筛选实际改变表格/图表数据;编译内容/命中/z 序与作者一致;空结果/缺绑定/长中文/overflow/隐藏组件各有结果或明确阻断;
- 验证:T+W+GPU+WEB(design-taste 双轮截图在 UI 切片时执行)。
