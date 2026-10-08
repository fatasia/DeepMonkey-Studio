# 图谱行动预览输入

图谱侧栏应让作者选择真实对象身份、填写行动参数并看到服务端风险和影响范围。

## 现状核查

1. 检索 packages/apps 的行动预览、canonicalId、inputSchema，核对未跟踪文件。已有 ActionPreviewPanel；桌面 GraphView 未传回调，移动列表已传。
2. 读取 OntologyActionPlanInput、OntologyIdentityMapping 与服务端 resolvePublishedAction/assertTargetIdentity。目标是实例身份，包ID可消除多包同名歧义；已发布要求与参数验证不得改变。
3. React、现有表单 CSS、Vitest 已在用，不新增组件库或依赖。
4. previewOntologyAction 是现有 POST 消费。原面板用生成的类型ID和空参数，与有身份映射、必需参数的行动不兼容；没有其他行动实例参数输入UI可复用。
5. 现有 GraphView SSR、行动服务与路由测试保留；SMT QA 的 Device 身份为 SMT-01，smt.inspect 要求 plan。当前本体因真实拖线已为草稿，须经过既有评审发布后预览。
6. 已读 Astra 分镜、SMT录制工单、AI-first 和行动运行历史规格，S09缺实际可用预览入口。

已有（不重建）：行动定义、身份映射、参数schema、预览API、授权/发布校验、预览结果组件。真实缺口：桌面回调、实际目标选择、参数输入。

## 实现与验收

桌面和列表共用稳定回调。沿既有预览面板增加身份选择与参数JSON输入，不自动调用；明确发布前不可预览。已登记身份可选择，无映射对象由作者输入身份；参数必须为JSON对象。包ID、真实canonicalId、完整参数传入原API，服务端保留最终校验。

采用 design-taste-digitaltwin 标准，沿既有侧栏与base.css令牌，无新色系。目标身份/完整嵌套参数/包ID/错误输入合同、桌面入口SSR及既有决策链回归22项通过，Web类型检查通过。真实QA参数预览与1920/480两轮浏览器检查待完成。

录制使用独立QA的实际行动节点 `action:smt.inspect`，对象身份选择 `SMT-01`。`deliverables/studio-020-20261007/intro-astra/action-preview-parameters.json` 已更新为真实完成run `74b77de6…` 的 `data.query.read` 参数，计划指纹 `d37dbe4b…`。本体经现有评审发布后，将参数填入“行动参数”，点击“预览行动”，查看服务端返回的身份、风险与影响。数据集版本变更时须重新生成计划。

实页已完成正式评审发布v2及同目标预览。服务端读回与屏幕一致：低风险、无需审批、影响Sensor/Alarm/WorkOrder、可执行。真实take2及12秒正式字幕试片进入系统片S09和功能片本体章；本轮仅预览，不是行动执行。记录见[SMT录制工单](../assets/studio-020/intro-astra-smt-capture.md)。
