# SIM 工作台停靠与视口让位验收（2026-09-06）

状态：**已完成本批有限验收**。最终 r8 两轮真实浏览器四组通过；不代表全部 SIM-1a / 1b / 1c / 1d 或全站验收完成。

## 范围与设计依据

本批仅推进 SIM-001 的工作台布局：左停靠、右停靠、恢复浮动、停靠收起；复用既有四仿真插件、物流表单、DES、Study 与时间线。不新增引擎、算法、结果仓或仿真输入副本。

参照 [Siemens Plant Simulation 官方入门手册](https://www.plm.automation.siemens.com/en_us/Images/PlantSimulation_Step-By-Step_ENU_tcm1023-143387.pdf) 的停靠窗口与自动隐藏组织方法，以及 [Unity 官方窗口模式](https://www.foundations.unity.com/patterns/windowing) 和 [工作区布局说明](https://docs.unity.cn/Manual/CustomizingYourWorkspace.html) 的停靠、浮动和布局偏好。这里提炼工作台交互规律，不宣称复刻当前 Process Simulate 的精确界面，也不复制竞品品牌或资源。

按 `design-taste-digitaltwin` 先读既有表单和 `styles/base.css` 令牌，新增强调色仅用 accent 派生；工业表单保持清晰分组，视口保留既有场景氛围。停靠是即时几何调整，不加宽高动画，不引入额外运行循环。

## 实现与状态边界

- 同一面板支持左右停靠 / 浮动。浮动记忆原位置和尺寸；停靠宽度独立调整，支持鼠标拖动和键盘方向键，每次 24px。
- `AppStudioViewport` 只增布局接线：原视口和原工具层位于稳定的 `studio-scene-surface`，按停靠宽度收缩；面板是其稳定兄弟节点。不是把大窗移动到右边继续盖住 canvas。
- 收起成为 44px 侧条，保留运行与表单；Esc 只在面板内收起，已被内部控件处理的 Esc 和输入法事件优先。焦点转移到展开按钮，关闭 X 沿原清理路径卸载。
- 四标签切换、左右切换、收起 / 展开不换表单宿主；关闭或刷新不恢复未提交种子、运行结果或历史回放。重开默认展开，避免上轮运行自动收起后再次打开只剩空条。
- v2 localStorage 只白名单保存位置、尺寸、停靠方向；兼容旧 v1 浮动矩形，损坏 v2 可回退 v1，旧键不删除，受限存储不阻塞面板。折叠属于本次打开会话，不混入场景实体、Study 或服务端保存。
- 窄窗（≤1180px）停靠时临时让场景树 / 检查器收起，浮动或关闭后恢复其原偏好；真正不足 640px 的可用区域自动降为侧条，可恢复浮动。常规停靠至少给 canvas 留 280px。
- 真实视口缩窄时，工具坞按容器而非整窗宽度收纳；≤680px 使用既有图标模式，≤440px 两行并将菜单限制在工具条范围。

## 源码与聚焦证据

- 纯布局合同 / 存储：`apps/web/src/simulation/sceneSimulationLayout.ts`。
- 运行时几何 / 手势：`apps/web/src/simulation/useSceneSimulationLayout.ts`。
- UI：`SceneSimulationPanel.tsx`、原 `styles/sceneSimulationPanel.css`；宿主仅 `views/AppStudioViewport.tsx` 接线。新文件均小于 300 行，面板小于 400 行，未拆引擎或改公共合同。
- 聚焦：`sceneSimulationLayout.test.ts`、`SceneSimulationPanel.test.ts`、`sceneSimulationRegistry.test.ts`，补菜单紧凑范围和分隔条合同后 3 文件 **17/17**；覆盖旧偏好迁移、非法值、存储限制、布局白名单和几何边界。加入恢复比较及决策回归后，09:09:23 **5 文件 25/25**；随后 Web typecheck exit 0。全仓构建 / 类型 / 测试数字由根总账记录。

## 真实浏览器复核过程

全部使用 `createIsolatedStudioGate` 的独立 API、临时数据目录和浏览器，生产 bundle；不读用户 token，不访问原项目，不运行旧 GLM 破坏性脚本。

1. `simulation-docking-FK9HDT` 是夹具缺少原场景投影造成的 404 / 未保存场景失败，已补隔离夹具，不改产品绕过错误。保留失败证据。
2. r5 `simulation-docking-pl7SSK`：两轮 dark 1440 / light 980，**4/4 行为通过**。canvas 宽度 dark 888→468→收起844→浮动888；light 470→停靠560→收起936→浮动470，窄窗停靠临时收侧栏确实生效。对比度最低 dark 6.00 / light 5.00；无 API 写入和产品错误，首组已知 ANGLE X4122 驱动诊断单列。
3. 截图亲审没有将自动断言通过当成视觉完成：发现 1440 停靠后的工具坞仍按宽屏排列导致尾部被裁切，以及通用 28px 按钮最小宽度撑大 6px 分隔条、hover 遮住表单左缘。两项在原 CSS 根因修补；r5 截图保留为修复前证据，不能替代最终验收。
4. r5 相邻 `scene-plant-flow-ScU6Mu` **4/4**：四对象角色 / 三连线→参数→保存刷新→真实 DES Study→唯一时间线 / 暂停→原快照复现→关闭清理；对象变换及保存内容无 helper 污染。仅夹具项目实际写入；既有算法 / API 合同不变。该证据对应 r5，后续 CSS 门禁另列。

5. r6 `simulation-docking-u1ZNdC` 严格菜单断言发现 468px 容器的“创建”菜单仍向右越界；菜单锚点原只覆盖 ≤440px，已扩大到整个 ≤680px 紧凑范围，不删菜单 / 放宽断言。
6. `source-CSS-preflight` 产物仅是明确标记的隔离候选样式预检，**不计生产验收通过**。`Tq8Z9D` 导出恢复副本发现稀疏旧快照的默认字段补齐与约 1e-15 相机尾差导致误恢复；这是旧快照兼容缺口，不只称测试问题。本批不忽略默认字段或任意浮点。
7. setup 改用正常“保存项目”形成完整快照后，`524AV1` 仍弹恢复提示，逐字段差异仅 `updatedAt`。恢复比较原实现移除时间戳后直接 JSON.stringify，对象键顺序仍会误报。09:08:42 先红测复现，再改为只递归排序对象键，保留数组次序及所有真实数值 / 字段；测试验证微小数值修改仍要恢复。此修补在 `workspaceRecoveryStore.ts` / 对应测试，不改 API / 引擎 / 权限。
8. r7 正式 `simulation-docking-jURqTd` 两轮 **4/4**，完整基线后恢复误提示不再出现，canvas / input DOM 保持、所有菜单实际点击、布局零 API 写入均通过；`scene-plant-flow-ApwMDa` **4/4** 再次通过真实 Study 全链。截图再查到最窄 288 / 380px 画布的两行工具坞覆盖标准视图顶部按钮，因此在同一 ≤440px 容器规则令标准视图下移，门禁补全菜单关闭后的方向按钮命中，不能把 r7 行为通过写成最终整体验收。

最终门禁：`apps/web/scripts/gate-simulation-docking.mjs` 增加实际 canvas clientWidth、同一 canvas **和 input DOM** 连续性、所有工具坞按钮边界与命中、三个菜单真实开关和工位 / 物流切换、最窄 canvas、分隔条 hover、原输入保留、关闭 / 刷新仅布局恢复、恢复提示应不存在、零服务端写入断言。初次正常保存是隔离 **setup**，精确等待 `/workspace` 事务完成与按钮恢复可用，校验对象名 / 颜色 / 可见性 / 位姿不变，然后 GET 完整基线并封锁所有浏览器 API 写入。

## 最终 r8 证据与截图亲审

`node apps/web/scripts/gate-simulation-docking.mjs`：`test-output/codex-2026-09-05/simulation-docking-l0h7w8/report.json`，`mode=frozen-production`，两轮 dark 1440 / light 980，**4/4、exit 0**。没有候选 CSS 注入；4 组布局阶段 API 写入均为 0、产品 console / pageerror 均为 0，仅首组已知 ANGLE X4122 驱动精度诊断单列。

| 组合 | 原 canvas | 420px 停靠后 canvas | 600px 停靠后 canvas | 收起至44px后 canvas | 恢复浮动后 canvas |
|---|---:|---:|---:|---:|---:|
| dark 1440（两轮一致） | 888 | 468 | 288 | 844 | 888 |
| light 980（两轮一致） | 470 | 560 | 380 | 936 | 470 |

以上均为实际 `canvas.clientWidth`，单位 px，不是只读 aside 位置。980 停靠临时收起两侧栏，因此停靠后的可用 canvas 比原来宽；浮动 / 关闭恢复原 470px。左右 canvas / panel 边界无重叠，documentWidth 不超过浏览器宽度。

四组均验证：真实拖动 top +20px、浮动键盘缩放、左右停靠键盘 Enter、侧边方向键 24px 调宽、Esc 收起并转移焦点、展开与切换标签保留原 input DOM / 值、canvas DOM 连续、恢复浮动矩形、关闭后新表单、刷新仅布局偏好恢复、完整保存基线后的恢复提示不再出现。三个工具菜单真实打开 / 关闭，菜单内切工位再回物流；菜单关闭后 **6 个标准视图按钮**全部边界与命中正确。标准视图本批验证可达性，没有把这一断言扩大成六相机朝向算法重新验收。

亲审两轮的左右停靠、菜单展开、浮动恢复、44px 侧条、288 / 380px 极窄画布、分隔条 hover 及重开截图：未见工具坞尾部截断、下拉越界、分隔条遮住表单左缘或标准视图被工具坞盖住。代表图（均在最终目录）：

- `r1-dark-1440-left-menu-accessible.png`：宽屏左停靠后菜单仍在实际视口内。
- `r1-light-980-right-rail-retained.png`：44px 收起条与完整可用画布。
- `r2-light-980-narrow-canvas-controls-clear.png`：双行工具坞与标准视图分开，无隐形按钮遮挡。
- `r2-light-980-narrow-canvas-splitter-hover.png`：6px 分隔条 hover 不盖表单。
- `r2-dark-1440-reopened-layout-only.png`、`r2-light-980-floating-restored.png`：布局恢复与新表单 / 原表单生命周期区分清楚。

标题 / 标签 / 页脚正文最小对比度 dark **6.00**、light **5.00**；可见业务文字按现有工作台 12px 下限，截断描述有 title。最后相邻真实仿真证据为 r7 `scene-plant-flow-ApwMDa` 四组（前一轮 r5 `ScU6Mu` 四组），保存 / 刷新 / 正式 Study / 单时钟暂停 / 复现 / 关闭清理均通过。r8 最后仅改最窄容器的标准视图位置，未再次执行相同 DES 算法；不把 r7 产物改称 r8 产物。

### 十维自评（只涵盖本批布局）

| 维度 | 自评 | 实证与边界 |
|---|---:|---|
| 布局构图 | 9 | 实际 canvas 让位 / 恢复、菜单和标准视图零遮挡、窄窗侧栏恢复 |
| 令牌一致性 | 9 | 新布局 UI 使用既有令牌，双主题最低文字对比度 6.00 / 5.00 |
| 排版 | 9 | 主标题单行、描述可 hover、既有 12px 工程文字下限 |
| 交互状态 | 9 | 键盘 / 指针、收起 / 展开 / 关闭区分、禁用原因、偏好异常回退与输入连续性 |
| 动效 | 9 | 布局即时切换，不加宽高动画或多余运行循环；沿用既有微反馈 |
| 3D 渲染 | 不适用 | 本批不改渲染算法 / 材质；canvas 连续性不是整套画质评分 |
| 信息设计 | 9 | 配置区与画布分工、折叠保留工作、正式结果仍由 Study 统一管理 |
| 反馈即时性 | 9（状态） | 位置 / 收起 / 焦点响应可见；未单独计时证明所有动作 ≤100ms |
| 响应式与主题 | 9（限定） | 两轮 1440 / 980、实际 288 / 380px 视口及双主题；未覆盖 480 编辑器 |
| 语义与文案 | 9 | 停靠 / 浮动 / 收起 / 关闭准确，布局恢复不冒充业务或历史回放恢复 |

以上是有限范围自评，不据此宣称全站 Kimi-95、Siemens 全量同级或所有用户项目已通过。停靠保留作者相机，不自动重新取景；模型可能随可用视口缩窄而显得更大，已保持“适应全部”入口可达，不擅自改相机或原模型。

## 剩余分类

- **本轮待办**：稀疏旧快照默认字段 / 浮点尾差的语义归一化兼容（键序修复不冒充解决此项）；关闭后历史回放恢复、更完整运输资源 / 连续 AGV 轨迹 / 空间热力、跨仿真域时间线轨道依 SIM-001 后续范围推进。本批停靠不计作这些能力。
- **明确排除**：新仿真算法、认证动力学、OLP、控制器矩阵、新结果存储；用户暂停的 AskData / 语义公开治理、专项性能 / 大模型稳定性 / 全仓长文件治理不因本批重开。账号 / 存储 / 原场景不改，无 push。
- **项目级后验收**：真实工业客户项目、复杂仿真输入与多域运行，以及全站可访问性 / 性能指标。相同 canvas DOM 与组件键稳定不冒充直接测量 renderer 构造次数，固定立方体也不算整套 3D 画质验收。

## r9 共享主按钮样式相邻回归

根任务将通用实色主按钮接入 `--on-accent` 后，在统一 r9 正式构建上再次执行同一门禁；本次不改 SIM 生产源码、不注入候选 CSS、不重建 bundle。

`node apps/web/scripts/gate-simulation-docking.mjs`：`test-output/codex-2026-09-05/simulation-docking-33Wdbl/report.json`，`mode=frozen-production`，两轮 dark 1440 / light 980，**4/4、exit 0**。实际 canvas 宽度与 r8 表格完全一致；拖动 / 停靠 / 收起 / 浮动恢复、输入与 canvas DOM 连续、菜单与六方向按钮命中、完整基线后无恢复误提示、布局零 API 写入均通过。四组 `errors=[]`、`writes=[]`，仅首组已知 ANGLE X4122 驱动诊断单列。抽样文字最小对比度仍为 dark **6.00**、light **5.00**。

亲审两轮代表截图：`r1-dark-1440-left-menu-accessible.png`、`r1-light-980-right-reserved-canvas.png`、`r2-dark-1440-narrow-canvas-controls-clear.png`、`r2-light-980-floating-restored.png`、`r2-light-980-narrow-canvas-splitter-hover.png`、`r2-light-980-reopened-layout-only.png`。菜单边缘、极窄画布按钮、分隔条 hover、表单与页脚文字未见共享样式回退；浮动保留当前输入、关闭重开仅恢复布局的差异仍明确。

本次只做共享 CSS 相邻回归，没有重跑正式 Study；真实 DES 全链证据仍引用前述 r7 `scene-plant-flow-ApwMDa`，不改写其构建归属。隔离浏览器及 API 已关闭，原账号 / 存储 / 业务数据未改，无 commit / push；前述有限验收与遗留边界不变。
