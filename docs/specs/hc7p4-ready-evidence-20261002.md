# H-C7-P4 ready 五题证据核查与回填（2026-10-02）

## 现状核查（六步）

1. 全仓检索 `packages/*/src`、`apps/*/src` 的 `useAppSceneSyncEffects/applyScene/restoreSceneFromSnapshot/studioUngradedColor/studioColorAdjustment/SceneGraphHistoryBridge/clearcoat`，并核对 `git status --short --untracked-files=all`。基准、graph driver/history bridge 与 receipt 均包含未跟踪成果；本线只读，不覆盖并行产品改动。本地 `bim-studio/AGENTS.md` 实际不存在，按已加载用户/父目录约束执行。
2. 合同已读：`packages/contracts/src/scene.ts` 的 `SceneSnapshot/PrimitiveState/SceneMaterialState`；`packages/scene-sdk/src/protocol.ts` 的 `SceneMaterialCommandPatch/SceneCommand`；`packages/deep-engine/src/scene/types.ts` 的 revision/generation/层级合同。`material.set` 白名单没有 clearcoat、customShader 或色彩分级字段，不能把 I23 内核支持等同该作者命令支持。
3. 依赖已查：root、apps/web、packages/deep-engine、packages/scene-sdk、packages/contracts 的 package.json。已有 Three 0.185.1、Vitest 4.1、tsx；实机 Node v24.18.1、pnpm 11.18.0。零新增依赖。Deep 包 `test` 含扩大回归的后置 gate，本线用其既有 `pnpm exec vitest run <明确文件>`，不触发 cargo/GPU/帧时。
4. 消费方已查：App → useAppSceneSyncEffects → persistence.applyScene；viewerEngineObjectState 的作者分级 userData 链；editorPrimitiveDeletion 的真实控制器/快照/逆算子；graph bridge 的消费方实际仅正式测试与 `scripts/native-author-primitive-undo-redo.mts`，不是 App 的 Ctrl+Z/Y 生产装配。`hc7-p3-reference-consumption-20261002.md` 明示 driver 与浏览器主作者链边界，不把两个宿主闭环拼成一个。
5. 测试/证据已查：A4 五文件、A5 `editorPrimitiveDeletion.test.ts`、B1 I23/clearcoat 与 sceneCustomShader、B2 快照/控件/sourceMaterialReset、C2 既有 history 与 graph driver 正式测试；读完两样例结构及 P3 save-reopen/undo-redo receipts、P4 浏览器报告与 round2 JSON。已有浏览器报告明确 B1/C2 未过；不能只取全绿总数。B5 两轮真实路径是 `test-output/p4-b5-lighting-20261002/round{1,2}/report-round{1,2}.json`，不是 report.json，两轮各 21/21、4 个 committed、0 failures，只引用不重跑。
6. 规格/恢复上下文已查：完整读 P4 基准与 P3 reference-consumption、P4 browser acceptance、P4-B5 browser acceptance；检索 docs/specs、docs/handoffs、docs/reports 与 active-task-recovery-ledger。root `docs/specs/jc-i-continuation-20261001.md` 只读。其“11 题”枚举实际为 13 个不同 ID；当前基准表 A1/A2/B3/B4/C4/C5 的列数也不一致，须恢复每题一行、20 个唯一 ID，保留原门与 CPU/组合证据边界。

**已有（不重建）**：全部正式测试入口、编辑器保存恢复/历史栈、SDK 混批与微任务身份守卫、I23 层栈/拒绝守卫、两轮 P4/B5 浏览器证据、graph 重开/历史桥。

**真实缺口**：只把 ready 当入口而没有逐门证据登记；A4 未显式证明同一版本口径重开前进；B1 命令白名单与 ABI 接线缺口；B2 userData 链零调整逐位恒等缺直接证据；C2 10 步产品链缺口及历史第二次撤销失效。只运行既有正式 runner、落证据并如实回填；不改产品、不重写测试、不建第二宿主。

## 执行方案与证据口径

- 每题独立日志和 Vitest JSON，另跑共享 graph 正式测试（只跑一次，跨题引用不重复计数）。在 `test-output/three-migration-bench-20261002/ready-evidence/` 落盘。
- 测试以退出码、实际发现文件、完整断言名及断言结果核对；CPU跑绿不写成GPU/真实浏览器。初次核验 `browserExecuted/gpuExecuted=false`；后续只有C2/B2授权fresh设true（限WebGL截图行为证据），`frameTimingMeasured/cargoExecuted=false`始终保持。
- 初次核验仅CPU未运行Playwright；随后协调者明确授权C2连续撤销/颜色同族根因修，并串行交接GPU窗口，复用原P4 runner两fresh（严格颜色门42/42×2）。既有A4/B5浏览器证据只引用，不宣称fresh。
- 状态规则：仅全部原验收门满足才 done；部分门通过而缺产品/直接证据为 partial；测试运行失败则 blocked，保留退出码与日志。不放宽原门。

## 七轴矩阵（方案）

| 轴 | 本批覆盖入口 | 不能越域声称的部分 |
|---|---|---|
| 主路径 | 快照保存/应用、混批提交、材质编译、分级发布、history/graph 正式测试 | 浏览器 10 步作者链无 fresh 实测 |
| 边界 | 空栈/redo 分支、重复对象/非法 schema/非法材质参数、neutral grading | userData 的原始线性色逐位零恒等缺口 |
| 失败 | 幽灵命令回滚、未支持 ABI、事务窗口拒绝、恢复失败 | 不新造故障宿主 |
| 并发/重复 | SDK cancel/同 ID 微任务替换/较新作者版本拒绝/迟到路由响应 | graph bridge 不等于 App 消费 |
| 恢复 | 快照 JSON/正式恢复调用、既有浏览器保存重载报告 | A4 同版本重开 revision 读数待证 |
| 权限 | 能力/scene mismatch/locked/缺宿主 fail-closed | 不扩为完整账户 UI 权限矩阵 |
| 呈现 | 仅引用历史截图与实际报告 | 本批无浏览器截图闭环，不评视觉完成 |

## 实测结果

| 题 | 结论 | 正式入口与逐门证据 | 落盘证据 |
|---|---|---|---|
| A4 | done（组合引用，非fresh浏览器） | 原5文件39/39（旧38+原save入口补1）；生产save→JSON→applyScene本地scene revision 3→4恰1次，恢复ready；旧浏览器两轮1模型+2图元/TRS/material/2成员编组保持。明确local revision，不是服务器updatedAt或graph revision | `test-output/three-migration-bench-20261002/ready-evidence/a4-result.json`、`a4-final-vitest.json/.log` |
| A5 | done（正式CPU） | editorPrimitiveDeletion 11/11，真实控制器混批createX/deleteY、ghost逆算子+快照回滚、同ID微任务保护、新作者版本拒恢复 | 同目录 `a5-result.json`、`a5-vitest.json/.log` |
| B1 | partial | I23/clearcoat 29+编辑器入口2=31/31，但material.set白名单和v2/v3作者→运行时链仍缺；非clearcoat作者源持久化不替代本门，不改ABI | 同目录 `b1-result.json`、`b1-deep-vitest.json/.log`、`b1-web-vitest.json/.log` |
| B2 | done（修后CPU+双fresh） | 原25/25；materialSlotsRuntime最终6/6（新3）；zero三线性色9通道F64恒等、clone/显式色基准/同相位graded负控；两fresh42/42共同门，author #D4A84F/0.35/-0.30保存，reload显示#E5C490恒等，zero回#D4A84F | 同目录 `b2-result.json`；`c2-b2-color-browser/round{1,2}/report-round{1,2}.json` |
| C2 | done（修后CPU+双fresh） | 唯一history最终32/32（旧23+新9）；10混合编辑→10undo→10redo逐步比较TRS/分级/实际材质色，CAS新版x99拒覆盖、strict恢复失败/重入/迟到通知/redo pending分支；两fresh42/42共同门（不是两个84案例） | 同目录 `c2-result.json`；两轮各34张截图+报告 |

最终唯一计数：Web **24文件216/216**（`final-web-all-vitest.json/.log`），Deep B1 **4文件29/29**，合计 **28文件245/245**，共享graph/同族只计一次。类型 `final-typecheck.log/.exit`=0；隔离 `c2-color-web-build.log/.exit`=0。初次171绿单独保留，不把增量累计重复相加。最终色/历史8个actual源码与runner SHA冻结前后 **8/8未变**（`color-source-freeze.json`）；本线只读root SHA前后均 `8a62cb108c6c45979dbf1f3de19f862c7038fe5dda0ef6e92ab53365b2ba334b`。

基准表校准：20唯一ID、每组5；旧声称11的名单实际13；本轮行内注明范围 **17 done/1 partial(B1)/2 blocked(D1/D3)**。CPU/合同/组合范围仍保留限定，不宣称17题完整GPU认证、100盒或Tween像素门闭合。B5已读真实两报告21/21×2、4committed/轮、10图，仅复用不跑。

## C2 第二刀：连续撤销根因修复（与上述核验分开）

协调者明确授权继续修 C2，认领 `useSceneHistoryState.ts/.test.ts`、`useSceneHistoryActions.ts/.test.ts`、`sceneAuthoringHistory.ts/.test.ts` 及新增聚焦 `useSceneHistoryActions.chain.test.ts`；`scenePersistenceController.ts`、App、公共 contracts 与其他会话产品叶只读。

### 续作六步核查

1. 全仓检索历史/快照/撤销消费与未跟踪文件，保存 `ready-evidence/c2-consumer-survey.log`；确认已有 S2b Play 计数改动保留。
2. 已读 SceneSnapshot/SceneEditTransaction/SceneAuthoringHistoryState/ScenePersistenceControllerContext 与 AppState 版本/代际字段，零公共合同变更。
3. React/react-dom/Vitest/Three 已有；不引入依赖、DOM 框架或第二宿主。
4. App Ctrl+Z/Y 与工具栏共同消费 useSceneHistoryActions；每次 undo 无条件 flush，真实 makeSceneSnapshot 与 applyScene 重水合在原叶中，graph bridge 不是 App 权威入口。
5. 既有 deletionFixture 复用真实 Viewer 原型、makeSceneSnapshot、生产 persistence；第一次红跑为测试形参误用（ModelTransform 对象误喂数组入口），单独保留失败日志；修正夹具后 `c2-red-product-vitest` 明确红复现第二次 undo：期望 x=0，实际 x=2。恢复读回显示材质补出 hue/saturation/brightness/contrast=0，另有缺省坐标/工程分析/面板归一化，历史 fingerprint 与恢复事实不等。
6. 已读 P4 浏览器缺陷报告、历史 specs/恢复上下文与 root 只读账本，现有 CPU 测试未覆盖这条恢复读回差异；本刀修机制而非增加等待或放宽断言。

**根因**：恢复后的实际作者快照与栈的旧序列化 before 不同（默认字段/归一化）；下一次无条件 flush 把恢复本身再记为用户编辑，undo 消耗幻影。另有同族门缺失：flush 不检查 applying、动作不互斥、生产 apply 缺严格 requireComplete、恢复结束后没有版本 CAS，错误回退可误动较新历史。

**方案**：唯一栈增加本地单调版本及 `acceptRestoredScene(snapshot, expectedRevision)`，只接纳当前恢复读回作为 clean 基线，不增加条目、不清 redo；actions 在 strict apply 完成及 React 状态收束后按版本/场景所有者校验再接纳。散记/flush 共享 applying 门，重复撤销恢复互斥，失败仅在仍同版本时退栈指针。历史旧条目原样保留，不宽化全局指纹、不改保存语义、不用定时等待掩盖。补真实 10 次混合编辑→10 undo→10 redo、较新历史拒接纳、迟到事件/重复动作/严格恢复失败与邻居 Play/SDK 删除回归。新聚焦测试叶预算 ≤300 行，生产叶保持 ≤300 行。

当时先CPU复现与修复，未复验时C2保持partial；后续协调者交接GPU执行原runner，最终完整色门通过见第三刀及实测总表。

### C2/B2 色基线第三刀（真实同族缺陷，不能只签控件绿）

六步补核：全仓扫描 studioUngradedColor/studioColorAdjustment/getMaterialState/primitiveState/captureSceneModelState；重读 SceneMaterialState 与 patch（没有改公共合同）；已在用 Three/Vitest 零新增；消费链 `primitiveState → getMaterialState → makeSceneSnapshot → applyModelState → applyMaterialState` 与 glTF `readMaterialSlot`；复用既有 `materialSlotsRuntime.test.ts`（生产 ViewerEngineObjectState 原型）红测；对照 P4/B2 规格与旧浏览器报告无直接 F64 zero 恒等门。锁 viewerEngineObjectState.ts/materialSlots.ts/materialSlotsRuntime.test.ts，persistence/F5/PBR shader 均不触碰。

浏览器控件双轮 **37/37×2**（31 图/轮）虽过，逐图视觉复核发现 edit10 `#E5C490` → redo10 `#E1D3C1`，参数仍 0.35/-0.30；颜色不等不能称全域可逆。原双轮输出保全为控件子集证据。

CPU 红证 `b2-color-red-vitest.*`：序列化 color 错取已分级 `#e5c490`，userData 未分级基准实际 `#d4a84f`；zero 下输入 `[0.1234567,0.3456789,0.5678912]` F64 位从 `[4593560413433027186,4599898817378825292,4603290328738690384]` 变 `[4593655177639661312,4599917284953748036,4603261688598530033]`。**精确根因**：作者 color 读回采的是最终 RGB，并在重载后再次套分级；零路径先 hex 量化再 HSL/contrast 往返，不是位恒等。

方案：已有未分级author基线继续唯一权威，getMaterialState/readMaterialSlot读它；userData同时保留未分级线性数组（clone已有JSON形态），zero完全直通恢复数组，不进HSL/contrast；非零从基线算一次；sourceColor同步基线。正控/同相位graded负控/F64位恒等/JSON重载/clone基线已通过，原runner严格可见hex双fresh最终42/42×2（68图全部生成证据板逐图看完）。旧37控件绿仍保partial，不篡改旧证据。C2/B2本次原门通过；不改容差、不做帧时。

### A4 最后一门补证（不更改产品）

续核原保存/route/persistence/SceneSnapshot协议，确认场景无服务器revision字段；AppState.local scene revision是既有脏/clean计数，save只ack，applyScene结束setRevision+1。复用 `sceneWorkspaceSave.test.ts` 的原production apply fixture（只补numeric setter与bindSaved适配），真实saveScene→JSON→applyScene实测3→4/一次更新、lastAutoSaved=4、模型x99→保存值、restoreReady=true。原路由formal验证useAppSceneSyncEffects调用，既有双轮浏览器对象/材质/transform/selectionSets层级引用，组合证据明示非fresh。A4 39/39、零产品/公共合同改动。

## 失败证据与边界（与成功同等披露）

1. 修前C2旧browser `c2-defect-depth2-undo-refused` 的ok=true实际是登记失败，不计通过；CPU `c2-red-product-vitest` 实测第二次x2不退0。第一次自建聚焦夹具形参传错数组API单独保留 `c2-red-vitest`，不是产品缺陷。
2. 修历史后原runner首次 `.workspace-title` 不存在定位超时；先看failure截图/源码改为真实 `.scene-title-wrap > span`，未force/DOM注入，原失败完整归档 `c2-browser/attempt1-runner-locator-failed/`。
3. 历史修后的37/37两轮只是TRS/分级控件子集；逐图发现颜色漂移，保原 **62图** 和两报告为partial，不能拿这个“绿”覆盖材质门。色红2例与位读数见第三刀，修后新目录 `c2-b2-color-browser/`不覆盖旧证。
4. 最终浏览器pageErrors=0但console并非零：两轮各4次404资源错误，Three驱动编译warning各1；round2还有WS连接在建立前关闭warning。日志缺URL导致404具体资源未归因，作为既有环境/产品资源观察项保留，不宣称console clean；未出现STUDIO_RENDER_FAILED。完整原console在报告中可查。
5. 双轮1920×1080深色，68图已通过10张全图证据板逐一视觉复核并放大after-reload/zero等关键图；没有轻色/480/不同DPI/设备级性能测试。这是作者链行为门，不是全产品视觉95%或完整响应式认证。图层色文本同相位精确相等，非截图感觉替代数学门。
6. local history CAS防止接受/错误补偿覆盖较新历史，未新建跨外部引擎写的全域锁。历史snapshot的旧条目保留，恢复默认化clean基线接纳不是宽化fingerprint；camera浏览/playing/源材质还原既有边界未扩承诺。
7. 禁cargo/帧时、未commit/push/reset/clean/stash、保护用户数据达成；只隔离gate临时DATA_DIR/端口/自有Web产物。首批零新样例，续修新增正式测试leaf 170行，既有runner收窄C2/颜色参数复用，无第二宿主。

## 对抗复核与门禁自评

本表只评本次已界定工程/测试产出，不把未覆盖视觉矩阵想象成通过。

- 工程10维（9/10）：理解/方案/复用/实现/边界/错误处理/验证/性能/可维护/诚实均9；依据六步核查、红→绿机制复现、五生产叶最小修/保S2b并行改动、245唯一正式用例+类型、CAS与负控、冻结SHA、零shader/合同扩散。性能无新帧loop、只cold save/apply恢复，多一个3float基准；未测帧时如实不评分为实机收益。
- 测试8维（9/10）：覆盖深度/真实性/缺陷产出/家族清剿/证据/分级/边界/修复回归均9；≥4失败/边界实测（ghost/同ID/newer revision/strict load/pending重复/redo分支/zero+错误基准负控），原CPU正式与真实GUI逐键逐值/图双证；独立两fresh与红证保全，不用DOM存在当通过。console观察项不压级。
- 视觉10维不作全产品通过评分：布局9、令牌9、排版9、状态9、动效未测、3D观感9、信息9、反馈9、响应/双主题未测、语义9；本次未改视觉，双轮截图仅证明没有空白/断层/颜色漂移与反馈状态恢复，**未过完整视觉闭环范围认证**（reduced-motion/响应/轻色遗留）。对标西门子克制工业密度、Unity显式PBR/山海鲸空气感仅既有页面观感参照，无新视觉设计宣传。

最终源/证据manifest `ready-evidence/summary.json`，以实际退出码、逐断言状态、截图路径及SHA为准。
