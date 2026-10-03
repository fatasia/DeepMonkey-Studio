# P4-B5 浏览器验收：雾/环境切换经 lighting.set / environment.set 命令面（2026-10-02）

> H-C7-P4 Three 迁移 20 题基准 **B5** 浏览器宿主域验收。两轮独立隔离浏览器闭环
> **round1 PASS 21/21、round2 PASS 21/21**，四题验收全过；过程抓出并修复
> **两处真实产品缺陷**（B5 宿主实装批漏同族清剿）与 runner 三处合同/时序缺陷。
> 证据：`test-output/p4-b5-lighting-20261002/round{1,2}/`（各 5 张 1920×1080 深色截图 + report.json）。

## 现状核查（开工前六步）

1. runner 已存在（`apps/web/scripts/p4-b5-lighting-acceptance.mjs`，isolatedStudioGate 模式：独立端口/独立数据目录/OBJECT_STORE=local/spawn `apps/api/dist/index.js`）；`test-output/p4-b5-lighting-20261002/round1` 为上一批（d28e89a5）仅 mkdir 即失败的空目录，无历史产物可复用。
2. 合同层：`packages/scene-sdk` protocol/commandValidation/sceneCommandTransaction 的 `lighting.set`/`environment.set`（patch 合同、`studio.scene` capability、scene-mismatch 校验）已在；MCP 桥 `apps/api/src/mcpEditorSceneTransactionBridge.ts` 注入固定 module `mcp-editor-bridge`（含 `studio.scene`+`scene.write`），runner 无需传 module。
3. 消费链：`SceneCommandExecutor` 118-123 行已派发 setLighting/setEnvironment → `ViewerSceneCommandPort` 已实装（合并 getGlobalLighting→setGlobalLighting / getSceneEnvironment 合并+setWeather）。
4. **真实缺口（产物新鲜度）**：web dist（03:18）、scene-sdk dist（10-01 22:16）均早于 B5 源码实装（11:15-11:21）；api dist（11:42）新鲜但 9 个 workspace 依赖包 dist 陈旧（plant-lite-simulation 缺新导出 `createConveyorSensorAgvCalibrationModel` 致 API 启动即崩）。

## 链路与验收方法

MCP `tools/call editor.scene-transaction`（`/api/mcp`）→ API 桥挂起 → 浏览器 driver 短轮询拉取 →
scene-sdk validator prepare → `EditorSceneWriteDriver`（CAS + 逆算子回滚）→ capturing port 透传
`ViewerSceneCommandPort` → ViewerEngine；draft 回写 → 保存项目 → `saveApplicationWorkspace` 持久化 → 整页 reload → GET scene API 数值复查。

读证通道（按产品 draft/persisted 两层模型设计，不放宽）：

- **生效** = 事务 `committed`（receipt）+ draftRevision 前进（MCP resources 实时 list+read）+ 画布平均亮度（页面内解码截图像素）+ 截图留证；另加 **persisted 负控**（保存前 GET API 不得变化，证明 draft 隔离真实生效）。
- **持久化** = 保存后 GET scene API 数值断言（intensity 0.4 / GI true / weather fog / environmentIntensity 1.4 / backgroundColor #101418）+ 整页 reload 后复查 + 重载后亮度对比。
- **混批原子性** = lighting.set+environment.set 同事务 committed、receipt.commandIds 顺序恒等、幂等重放零退化、零 pageerror。

## 验收四题结果（两轮一致）

| 题 | 结果 | 关键证据（round1 / round2） |
|---|---|---|
| ① 灯光强度 set→生效→保存→重载保持 | **PASS** | draft rev 1→2；亮度 0.115732→0.094553 / 0.115732→0.094553（变暗）；persisted 负控=1；保存后 intensity=0.4+GI=true；reload 后保持 |
| ② 天气 set 生效持久化 | **PASS** | draft rev 2→3；亮度 0.094553→0.092695（雾生效）；保存后 weather=fog；reload 后保持 |
| ③ 环境强度+背景色 set 生效持久化 | **PASS** | draft rev 3→4；保存后 environmentIntensity=1.4、backgroundColor=#101418；reload 后数值保持、亮度恒等（0.0926953/0.0926950） |
| ④ 混批（lighting.set+environment.set）事务原子性 | **PASS** | `b5-idempotent` committed，commandIds=["b5-l2","b5-e3"] 恒序；幂等重放零退化；4 事务全 committed；两轮 pageErrors=0 |

截图（round1，round2 同构）：`test-output/p4-b5-lighting-20261002/round1/01-lighting-dimmed.png`（灯光变暗）→ `02-weather-fog.png`（雾）→ `03-env-intensity.png`（环境强度+背景）→ `04-after-reload.png`（重载保持）→ `05-idempotent-mixed-batch.png`（混批幂等）。逐张人工复核合格：1920×1080 深色编辑器、画布渲染正常、左侧灯光对象树可见。

## 发现并修复的产品缺陷（2 处，均为 B5 宿主实装批漏同族清剿）

1. **capturing port 漏场景级方法 → 场景级命令在 MCP 事务路径 100% 失败**。
   `apps/web/src/studio/editorSceneWriteDriver.ts` 的 `capturing: SceneCommandPort` 包装对象漏了
   `setLighting`/`setEnvironment` 透传字段，executor 走 fail-closed fallback（"当前宿主尚未连接场景灯光状态"）整批回滚。
   单测此前只测裸 `ViewerSceneCommandPort`，未覆盖 capturing 包装层，故未发现。
   修复：补两个透传字段（守卫风格与同文件 deletePrimitive 一致）；同族排查确认全仓仅此一处 SceneCommandPort 包装对象。
   哨兵测试 2 例：混批透传 committed+patch 原样到达宿主端口；宿主未实装时 rolled-back+unsupported 消息。
2. **命令路径缺 draft 文档回写 → 保存必丢命令效果**。
   UI 路径 `changeLighting/changeWeather/changeSceneEnvironment` = React draft state + 引擎 + 撤销栈；
   MCP 命令路径（`ViewerSceneCommandPort`）只推引擎。draft 不同步则 `makeSceneSnapshot`（消费 React state）
   保存时丢失 lighting/weather/environment——轴 4 持久化必然失败。
   修复：driver 导出纯函数 `sceneMetadataDraftPatch(commands)`（lighting patch / environment patch 剥离 weather /
   非法枚举忽略 / 多命令后写覆盖先写）；`useEditorPresence` 在事务 committed 后按拆分结果回写
   `state.setLighting/setSceneEnvironment/setWeather`（rejected/rolled-back 不触碰 draft；与相机同规不进撤销栈，如实登记）。
   哨兵测试 2 例（拆分正确性 + 覆盖序/非法输入忽略）。

## 发现并修复的 runner 缺陷（3 处，修复不放宽断言）

1. "生效"断言读 persisted GET API——与 draft/persisted 两层模型不符（保存前 persisted 恒不变）。
   改为：draftRevision 前进 + committed + 画布亮度 + 截图；**新增 persisted 负控断言**；持久化数值断言归位轴 4。
2. `baseRevision` 固定用初值——违反"baseRevision 必须来自刚读取的活跃编辑器资源"合同，首事务后必 revision-conflict。改为每次提交前实时读基准。
3. 轴 4 reload 后浏览器重建编辑器会话（sessionId 变新），轴 5 仍用旧会话提交必 unavailable。改为 reload 后重发现 active-editor（resources/list → summary → 新 sessionId/revision 基准）。
   另：summary 资源按 revision 寻址，事务后旧 URI 过期 404——读证改为每次重新 list 取最新 URI。失败诊断输出补全 receipt.results。

## 产物新鲜度批处理（前置条件）

重建 scene-sdk dist（含 lighting.set validator）→ web dist；plant-lite-simulation / data-query-plugin / data-runtime /
deep-engine / industrial-agent-orchestrator / jt-reader / plugin-runtime / server-sdk / studio-core 共 9 个陈旧包 dist 重建
（首个失败即 API 启动崩溃：`plant-lite-simulation` 缺 `createConveyorSensorAgvCalibrationModel` 导出）。

## 测试与回归

- 聚焦：`editorSceneWriteDriver.test.ts` **9/9**（原 5 + 新 4 哨兵）。
- 同族回归：apps/web `src/studio/` + `src/behavior/` **48 文件 255 测全绿**。
- 浏览器闭环：round1 21/21、round2 21/21，亮度读数逐位级复现。

## 如实声明（未覆盖/边界）

1. **web build 的 tsc 门当前被域外在途文件挡住**：`src/commands/SceneGraphTransactionDriver.test.ts`（语法半成品）与
   `src/commands/ScenePrimitiveOwnerPort.ts`（exactOptionalPropertyTypes 两错）属并行在途批（H-C7-P3 commands 域，mtime 与本批执行同时），
   本线不碰。本线改动文件经 tsc 逐条核验**零错误**（过滤上述两文件后无本线错误），dist 以 `vite build` 直出。
   **并行批收口后需重跑 `pnpm --filter web build` 确认全门**。
2. 轴 3 画面亮度与轴 2 完全相同（截图字节数相同）：空场景 + 非 none skybox 下，backgroundColor/environmentIntensity
   不改变画面（产品渲染语义：背景色受 skybox 模式门控，面板 UI 同门）。命令值已实证进入引擎 contract、draft 与持久化
   （轴 4 数值+重载保持）。该渲染语义登记为观察项，不属 B5 命令面缺陷。
3. 场景级命令 draft 回写不进撤销栈（相机同规）；UI 手动改灯光仍进撤销栈，两条路径撤销语义不一致为登记项。
4. 灯光 dim 的亮度差（-0.021）部分来自背景/网格，非模型直射光对比（空场景无模型）；数值断言主体在持久化轴，亮度仅作生效佐证。
5. 禁 cargo 达成（本线零 Rust 改动）；不 commit 不 push；改动文件 3 修 1 新增 runner（untracked）。

## 改动清单

- `apps/web/src/studio/editorSceneWriteDriver.ts`：capturing port 补 setLighting/setEnvironment 透传；导出 `sceneMetadataDraftPatch`。
- `apps/web/src/studio/editorSceneWriteDriver.test.ts`：+4 哨兵用例（透传混批/fail-closed 回退/draft 拆分×2）。
- `apps/web/src/hooks/useEditorPresence.ts`：事务 committed 后 draft 回写接线。
- `apps/web/scripts/p4-b5-lighting-acceptance.mjs`：断言通道重设计 + 会话重发现 + 实时 CAS 基准 + 诊断增强。
