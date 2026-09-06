# 2026-09-06 接续检查点

## 用户最新范围（优先于 09-05 历史计划）

- 持续修正已验证问题，其余功能任务并行推进；仅内层 `bim-studio`、`dev-studio` 本地提交，严禁 push。
- 用户明确暂停上一进度清单第 3 项：AskData / 统一语义消费 / 公开数据授权与版本治理。
- 用户明确暂停上一进度清单第 6 项：专项性能、大模型稳定性、长文件治理。必要类型检查、单测、构建、浏览器回归仍执行。
- 其余脚本真调试、模型独立实例与引用保持替换、仿真深化、AI 工作流、真实素材/模板、SDK 外部验收仍在队列。不可将当前修补批次完成当成全项目完成。
- 不改 admin/admin、.env、PostgreSQL + MinIO 拓扑、原场景。旧定时任务保持暂停，GPT 接入仍暂停。

## 已完成：有准确证据的修补

- R2 根渲染/启动失败恢复：`752b085`，18 个隔离浏览器用例通过。详见 `application-error-verification-2026-09-06.md`。
- 真实夹爪聚焦：本地提交 `2eff415`；`camera-framing-wGgINY` / `camera-framing-ihB18A` 两轮，44 作者状态、4 保存→刷新→发布匿名链路通过，原 GLB 哈希及比例不改。相机报告明确保留跨比例公开构图、飞行动效等低于 9 分项，不能称全套 Kimi-95 完成。
- SDK 可消费性前置：`sdk-consumer-cGONEo/lKsvLC` 两轮独立安装运行通过，新增三包 README、门禁和可执行样例，完整证据 `sdk-external-consumer-verification-2026-09-06.md`。包仍 private，未公开发行；更后续列表取消参数不改原调用，新构建后将补相邻复跑。
- 检查器局部主题和数字输入：`inspector-theme-7ajweL` 四组复检通过（更早两轮详见 `inspector-quality-verification-2026-09-06.md`）。
- F1 Esc/事务保护与局部弹窗主题：`dialog-escape-gaDn1U` 最终两轮四组通过，附 ZH/EN 1440 导航实测。完整证据/原报告真假核查在 `glm-report-verification-2026-09-06.md`，Vision 全套主题仍未通过。

## 本轮待办：当前并行所有权与新发现

1. SIM：沿已有拖/缩/折和物流闭环补左右停靠、收起、恢复浮动，视口实际让位；布局偏好与仿真业务数据分离。`glm_esc_finish` 负责面板、布局 hook/CSS、AppStudioViewport 最小接线、测试和浏览器证据。不是重写已有引擎/Study。
2. 管理目录：`camera_gate_finish` 已完成 SDK 前置，转而负责项目/场景/应用目录的加载、失败持久反馈/手动重试/请求身份与取消；只修三条目录，不接管现有模型轮询或非管理页文档加载。根负责 API 可选 signal 参数和 R1 浏览器测试。
3. 3D→2D：原运行控制器修改冻结场景的 thumbnail 导致保存中断，根已去掉重复捕获并统一由 saveScene 保存真实视口。新浏览器证实服务端 models=1，但 Store 的旧 acknowledgeSave 只接受相同指纹、把外部引擎新模型误当成异步冲突，二维仍用空场景。`inspector_finish` 负责 Store/Session 基线回声合并与并发/撤销单测，根负责 saveScene 调用和控制器用例；待新构建实测，不因路由返回成功就称全链通过。
4. R1：ServerClient 默认关闭恢复，仅 Web 明确目录/快照 GET/HEAD 对 502/503/504 或网络错误自动重试一次；写、401/403/429/500、取消/身份变化不重放。SDK 89 项、Web 边界 38 项通过。`read-recovery-hvigNu` 两轮四组通过，但截图仍发现目录最终失败误显示真空态；补持久错误与重试后需复跑。根新增 `authenticationRecheck` 责任模块保持原二次401语义并让 api.ts 不超过800行；已单测，等待下一构建。
5. 根统一生产构建与回归、分批本地提交、更新本检查点；所有代理不得并发重建共享 dist。

## 已完成：当前命令证据与限制

- 最近全量测试 r4：Web 363 文件 / 1319 项、API 119 文件 / 494 项及其余包通过；随后新增保存合并/鉴权编排等须更新数字。
- r4 root build 在 Web exactOptionalPropertyTypes 错误失败，六处 optional busy 已转 Boolean；r4b Web build exit 0，包/API 已在 r4 前段构建，`smoke-api-import` 通过。不是把失败构建写成通过。
- r4b root typecheck 类型通过，但 api.ts 新增至802行而体量门禁失败；鉴权编排抽取后 `quality:source-size` 1917 源文件通过。下一统一类型/构建仍待做。
- 正常 `pnpm studio status`：web 模式健康，API4100/Web5173，PID49856。隔离门禁的临时API/json/local不是正常拓扑迁移。

## 新报告的证据边界

原件在外层 `D:\Documents\bim\全量测试与验证报告-20260906.md`，不直接覆盖。原始 findings 不只有 PASS/INFO，也有失败与跳过记录；这些可能是修复前记录，必须按时间顺序核对末次回归，不能直接当作当前未修复，也不能删掉后宣称全绿。版本历史 Esc 存在“场景未发布，跳过”的记录，需独立重测。详细复核将写入 `glm-report-verification-2026-09-06.md`。

报告所述误删/恢复事故未经本轮独立完整恢复验收，不据此保证所有数据无损。仅执行隔离业务写和正常栈只读检查，不运行其旧破坏性清理脚本。

## 验收纪律

使用 design-taste-digitaltwin：Design Read → 现有令牌 → 实现 → 至少两轮截图亲审 → 十维评分 → 同族检查。未通过不称 Kimi-95/全站达标。
相机对标 [Unity Frame Selected](https://docs.unity3d.com/Manual/SceneViewNavigation.html) 的选中聚焦原则；计算基于 [Three PerspectiveCamera](https://threejs.org/docs/pages/PerspectiveCamera.html) 的透视范围。错误边界遵循 [React Error Boundary](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary)，不声称捕获任意异步或事件处理器错误。

当前是进行中检查点，不是完成报告；待补准确最终命令、截图目录、提交号及剩余队列。
