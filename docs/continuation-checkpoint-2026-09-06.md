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
- SDK 可消费性前置：`7d55d0d`，`sdk-consumer-cGONEo/lKsvLC` 两轮独立安装运行通过，新增三包 README、门禁和可执行样例。后续可选列表取消参数由 `sdk-consumer-wgdpKJ` 在空目录离线安装后用 Node/Chrome 再验，完整证据 `sdk-external-consumer-verification-2026-09-06.md`。仍为 private 协议/调度/HTTP 包，不是公开发布或可嵌入 Viewer。
- 检查器局部主题和数字输入：r6 `inspector-theme-slAvBf` 四组复检通过，紫色焦点跟随品牌；更早两轮和边界见 `inspector-quality-verification-2026-09-06.md`。
- F1 Esc/事务保护与局部弹窗主题：r6 `dialog-escape-xMgPZC` 两轮四组通过，附 ZH/EN 1440 导航实测；覆盖非空版本、发布 busy 和真实本地草稿恢复。完整报告真假核查在 `glm-report-verification-2026-09-06.md`，Vision 全套主题仍未通过。
- 3D→2D 保存一致性：本地提交 `b0f5fb4`；r6 `scene-shell-theme-ulm3QR/ScDsCs` 默认/紫色共8组实测，实际夹爪模型在2D显示、再回3D完整，API模型数组与GLB哈希保持。修复冻结对象缩略图赋值和 Store 错误回声判定；新增保存前实时基线、三方合并、跨文档/迟到响应保护、撤销保模型。详见 `application-save-reconciliation-verification-2026-09-06.md`。
- 对象目录和壳层局部主题：同上两轮验证 hover / 键盘动作展开后名字仍可读，六个动作可达；修复全局焦点硬编码金色。r5 功能通过时漏检品牌焦点的反例保留在 `scene-shell-quality-verification-2026-09-06.md`。
- R1 目录恢复：r6 `read-recovery-oHT3I5` 两轮4组通过。项目/场景/应用最终读取失败不再假空；仅白名单无请求体 GET/HEAD 对502/503/504或网络异常重试一次，取消和身份变化停止；写入、401/403/429/500从不自动重放。真实鼠标双击只一请求、键盘重试、持久错误、创建失败保稿与显式再提交全过；最低错误正文对比度亮5.00/暗6.00。r8 `read-recovery-yMhdLv/lOKOKh` 默认/紫色共8组已验证真空单主CTA、hover/focus对比度9.716/6.441；后续通用主按钮同族r9证据见最终追加。

## 已完成：本批并行功能与最后修补

1. SIM左右停靠、44px收起栏、恢复浮动、表单/画布不重挂载和实际让位。r8 `simulation-docking-l0h7w8` 两轮4组通过；真实最窄canvas288/380px菜单可用、六方向按钮无遮挡、分隔条6px不盖输入、真实拖动+20px、重开仅恢复布局。r7 `scene-plant-flow-ApwMDa` 正式运行/Study/暂停/复现/清理4组通过。布局操作零业务写；不是物理仿真或完整多域轨道完成。详见 `simulation-docking-verification-2026-09-06.md`。
2. 恢复比较键序误报：同数据仅对象属性顺序不同会误提示，红测确认后改为递归稳定对象键序；数组顺序、实际字段、微小数值和版本保护不放宽。完整保存基线后只调布局不再弹恢复，真实未保存变化仍由Esc门禁验证可恢复。旧稀疏快照默认字段/浮点尾差的语义归一化仍另列待办。
3. 管理真空场景页保留中央主动作，工具栏创建降次要，过滤无结果不误判真空库；两入口真实打开/取消无写。新增`--on-accent`由base.css定义黑/白文字令牌、品牌同步按亮度选择；已排查通用按钮/场景卡/2D顶部同族，不把页面深浅主题文字直接叠在实色品牌底上。
4. 鉴权编排保留原二次401语义，并覆盖凭据适配器同步异常/异步拒绝：失败保留登录，不产生未处理拒绝，pending可释放。聚焦白名单/鉴权2文件32项及r7/r8全量通过。账号和正常认证配置不变。

## 已完成：当前命令证据与限制

- r5 根 `pnpm build` / `pnpm typecheck` / `pnpm test` 均退出0：Web369文件1364项、API119文件494项、Core79项、server-sdk90项及其余包通过，API导入 smoke 通过。日志 `.runtime-logs/codex-20260906-features-{build,typecheck,tests}-r5.log`。
- r8 Web build / 全量 test、根typecheck 均退出0：371文件1386项，1932源文件均不超过800；r9仅主按钮同族CSS与门禁/回归测试增补，Web build / 全量371文件1387项再次退出0，首屏310.1KiB/gzip101.2KiB，预算通过。不是专项性能/任意场景性能验收。
- 旧r4 exactOptionalPropertyTypes失败、api.ts802行门禁失败已分别根因修复并经过r5全量确认，历史失败日志保留。
- 正常 `pnpm studio check`：09:03 web模式健康，API4100/Web5173，PID49856。隔离门禁的临时API/json/local不是正常拓扑迁移。

## 本轮待办：当前修补之后的功能队列

- 脚本源码级断点、单步与调用栈；现有自动生命周期、作者私有播放、日志源码定位不是此能力。
- 模型独立场景实例与保引用替换；当前模型资源与实例身份仍耦合，不能调用资源删除来伪造替换。
- SIM连续AGV轨迹/空间热力、机器人路径教学、PLC与What-if跨域轨道；现有18个DES样本、树/覆盖层/Study与时间线不等于认证仿真。
- AI-2～5工业工作流与质量评测；已完成的数据集选择/取消/重试不代表这些功能已全做。
- ≥10行业深度包、≥300可编辑业务模板目标；166缓存中只2项已真实审核入库，其余164待审。HDRI/PBR已有数量目标已满足，不重复下载凑数。
- SDK文档中心、一键插入修改样例、插件安装/启用/兼容与跨项目工作流；本批只完成外部包可消费性前置。
- 同族UI：2D检查器/Vision旧主题、980场景元素计数、局部旧页脚/工具、完整键盘焦点与更窄断点；相机曲线飞行与跨比例公开构图。确定的功能/视觉缺口不能改名“客户后验收”而消失。
- 旧稀疏场景快照默认字段/浮点尾差的语义归一化，及原GLM报告R3基于既有工具的一致性备份/隔离恢复演练；不新增定时任务、不执行正常库恢复或旧清理脚本。
- 其余原范围与依赖以 `platform-surpass-development-plan-2026-09-04.md`、`codex-glm53-handoff-2026-09-05.md` 后续回填为准；不因本清单聚焦当前直接队列而取消填报/打印、协作等尚未满足的原门槛。用户暂停的第3/6项仍单独明确排除。

## 新报告的证据边界

原件在外层 `D:\Documents\bim\全量测试与验证报告-20260906.md`，不直接覆盖。原始findings为121条，不是PASS/INFO合计98条；其中失败与跳过可能来自旧构建，必须按时间顺序核对。版本历史Esc原“未发布、跳过”已由本批真实发布/非空历史门禁补证；详细真假核查及R1/R3边界见 `glm-report-verification-2026-09-06.md`。

报告所述误删/恢复事故未经本轮独立完整恢复验收，不据此保证所有数据无损。仅执行隔离业务写和正常栈只读检查，不运行其旧破坏性清理脚本。

## 验收纪律

使用 design-taste-digitaltwin：Design Read → 现有令牌 → 实现 → 至少两轮截图亲审 → 十维评分 → 同族检查。未通过不称 Kimi-95/全站达标。
相机对标 [Unity Frame Selected](https://docs.unity3d.com/Manual/SceneViewNavigation.html) 的选中聚焦原则；计算基于 [Three PerspectiveCamera](https://threejs.org/docs/pages/PerspectiveCamera.html) 的透视范围。错误边界遵循 [React Error Boundary](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary)，不声称捕获任意异步或事件处理器错误。

当前是本批已验证成果及全项目剩余队列的交接，不是全项目完成报告。SemaPLC/Astral3D分析已在 `semaplc-astral-value-analysis-2026-09-05.md`，不要重复建设转换器或将Astral被注释的Revit配置当作已可用的RVT解析能力。

## 已完成：r9 最终证据（覆盖前文待复跑状态）

| 本批功能 | 最终正式bundle门禁 | 结果 |
|---|---|---|
| 目录恢复、单主创建动作、双品牌按钮 | `read-recovery-EVkckS/mqaLz2` | 各两轮双主题，共8/8；保稿/写保护不变，文字对比度金9.716/紫6.441 |
| Esc、发布busy、非空历史、真实恢复副本 | `dialog-escape-p6S2iL` | 两轮4/4，另8次ZH/EN1440导航通过 |
| SIM停靠/收起/让位/菜单/表单保留 | `simulation-docking-33Wdbl` | 两轮4/4，布局零API写，canvas/input DOM连续 |
| 2D主按钮同族、模型跨编辑器保存 | `scene-shell-theme-ER7rgY` | 紫色4/4，API模型完整/原GLB哈希保持 |

以上进程均退出0、隔离浏览器/API已关闭，截图已经两轮亲审；产品错误0，有意故障注入诊断与既有首组ANGLE精度警告单列。正式Study完整链沿用r7 `scene-plant-flow-ApwMDa`四组，不伪称r9重新运行算法。r9 Web全量371文件1387测试/构建退出0，根类型与1932源文件门禁r8通过。09:30正常`pnpm studio check`仍为web健康，API4100/Web5173，PID49856；账号、拓扑、原场景未改。

本批代码与证据已本地提交，未push：

- `b0f5fb4`：保存三方回声合并与跨编辑器模型同步。
- `e62bb8b`：目录读取恢复、Esc事务保护、检查器/壳层/主按钮令牌与相关证据。
- `5c3c843`：SIM停靠/收起/让位、纯布局持久化、真实浏览器门禁与规格回填。

提交后再次运行源文件门禁，1932源文件全部通过。上方“本轮待办”功能队列完整保留，第3/6项继续暂停。下一功能批次优先脚本真调试、独立模型实例/引用保持替换，可与SDK样例入口并行，先核对现有合同与实现，不重复建设；不能只补UI按钮冒充源码断点或独立模型实例。
