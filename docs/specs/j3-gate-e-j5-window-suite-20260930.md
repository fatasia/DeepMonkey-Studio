# J3 Gate E：窗口双端与 Web 候选门进入 J5

J5增加一对实际窗口恢复判据；Web完整候选成功与失败作为同组Web专项，Native继续按实际窗口destroyed重建语义验收。

## 现状核查

1. 源码/未跟踪：J5现12对24腿，executeGate已有command级复用；窗口默认runner已具名执行两fresh Native子进程及两Web实例，候选成功/失败另有独立叶子。保留其他专线改动。
2. 契约：现GATE_PAIRS、requiresGpu、ts/native side、executeGate、buildEvidence和currentRun/stable/passed JSON足够；contracts无J5进程编排合同，不引入产品API。
3. 依赖：现Node child_process/fs/path/assert与node:test可用，复用existing leaf，无新增依赖或测试框架。
4. 消费：package.json的gate:j5/gate:j5:gpu与J5 main只消费GATE_PAIRS；同command两腿已去重。窗口--web-only合并旧Native receipts，本门禁止该模式；Native DEEP_WINDOW_LOSS_CHILD/J3_WINDOW_NATIVE_OUTPUT继承变量须剔除。
5. 测试/证据：已有J5注入自测覆盖CPU/GPU策略、命令复用和失败传播；窗口实际两Native/两Web、候选成功/失败均已有独立实测。本次增加编排自测，不重跑已验GPU定位。
6. 规格：对照窗口/完整epoch替换/失败候选规格及当前J5证据。Native不同实际策略不改成Web候选模拟；最终strict整组由主线串行运行。

**已有（不重建）**：真实窗口默认双端门、Web两专项、J5策略/去重/序列执行和证据写入。

**真实缺口**：实际门尚未进入J5必跑图；没有同组fresh/source稳定证据汇总，也没有旧receipts或专项失败会阻断最终门的CPU自测。

## 最小接线

独立suite先清旧汇总与3个子门evidence，按窗口默认→Web完整候选成功→Web实际候选失败顺序各运行一次，拒绝非零退出/非fresh/非stable/非passed。只有3个fresh子门和源码身份前后都通过才写currentRun=true汇总；原窗口runner拥有Native具名Cargo执行，不重复执行该测试。

J5新增device-recovery-product-window对，两腿同`node scripts/j3-window-recovery-suite.mjs`按现command机制去重。双端窗口语义分别是Native实际destroyed重建和Web实际destroyed回退；专项明确为Web synthetic recreated通知与actual GPU candidate操作，actualUnknownDriverFault=false。

## 验证

仅CPU编排自测，最终Cargo/GPU由主线串行。新增第13对26腿；CPU模式新增两GPU格跳过、strict必须运行整个suite且失败传播。真实新suite汇总待主线最终运行。

两文件CPU编排自测33测通过，日志`test-output/interrupted-0930/j5-window-suite-tests.log`。覆盖三子命令顺序/去重、任一退出失败、不稳定/旧receipts、来源哈希缺省/漂移、隐式Native child环境、源身份期间变更及最终J5两腿失败传播。实际只读完整source快照成功；strict dry-run只列13对26腿，日志`j5-window-suite-plan.log`，没有运行Cargo/GPU。sources覆盖Web/contract/engine/Native代码、canonical WGSL、Native实际runtime-package夹具、依赖lock、子门与suite入口；子evidence源哈希逐项对初始快照，最终全体sha256必须保持。
