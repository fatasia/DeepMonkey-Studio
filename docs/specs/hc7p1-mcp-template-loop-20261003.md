# H-C7-P1 交付报告:MCP 客户端真实视觉循环衔接(模板产物作为输入)

日期:2026-10-03。任务行:`docs/specs/remaining-tasks-estimates-20260930.md` 行 164
(修快照标准 MCP 参数与可视 PNG 返回;Claude/Codex 实际握手、查询、截图、取消;4–8h);
接续点:`docs/specs/hc7p2-templates-20261002.md` §6「P1 的 MCP 客户端真实视觉循环衔接
(模板产物可直接作为其输入)」。本批认领可独立闭合的切片:**API 级闭环测试 + 同族真实缺陷根因修复**。

## 1. 现状核查(六步)

**已有(复用,不重建)**:

1. `apps/api/src/editorSnapshotFetchBridge.ts`:`fetch_editor_snapshot` 合同完整(白名单
   present-color/opaque-hdr/linear-depth、字节预算 fail-closed、完成结果短 TTL 幂等缓存、租约
   匹配、viewer 拒绝),已有 3 例类级单测;`index.ts:206/207/271` 已接线。
2. `apps/api/src/mcpEditorSceneTransactionBridge.ts`:`registerEditorSceneDriverRoutes` 已把
   snapshot-request/snapshot-result 两条 driver 轮询路由与写事务路由同点注册;
   `mcpEditorSceneTransactionBridge.test.ts` 已有「MCP inject + 浏览器 driver 轮询并发」的
   完整集成测试范式(createApiServer + preHandler 注身份 + inject 重试轮询),本批直接沿用。
3. `apps/api/src/mcpCapabilityAdapter.ts`:`/api/mcp` resources/list|read 已聚合活跃编辑器资源、
   场景上下文资源(scene-objects 等)与诊断快照目录(`mcpEditorSceneResources.ts`)。
4. Web 侧真实 driver:`useEditorPresence.ts`(1s 轮询、64MB 字节预算、分块 base64)+
   `studioFrameCaptureDiagnostics.ts`(有界 readback 历史)+ `editorDiagnosticsSnapshotReport.ts`。
5. 模板套件 `templates/deep-engine-3d/`:8 模板 `scene.ts` 为纯数据构造(import 全部 type-only,
   运行时零依赖),gate 全绿;`@bim-studio/deep-engine` 已是 apps/api 的 workspace 依赖。
6. 模板场景入 studio 的既有路径:`applicationRoutes` POST(经 `assertApplicationDocument`)+
   `migrateSceneSnapshotV1`(SceneSnapshot→ApplicationDocument)+ `JsonStore` 自带 default 项目
   (`storeUtils.defaultDocument`)。

**真实缺口**:

1. `fetch_editor_snapshot` 只有类级单测,**没有 API 级闭环测试**——MCP tools/call → 挂起 →
   driver 轮询 → 字节回传 → 幂等/TTL 全链路零覆盖;模板产物在该链路上零消费。
2. **同族排查发现真实缺陷 A(已修,根因)**:`EditorSnapshotFetchBridge.request()` 挂起
   Promise 无 setTimeout 兜底,超时结算依赖 `prune()`——而 prune 只由后续 request/
   takeDriverRequest 触发。浏览器会话死亡(driver 停止轮询)后,挂起的 MCP tools/call
   **永久悬挂**到 HTTP 层超时。同族写事务桥 `EditorSceneTransactionBridge.submit()` 有
   setTimeout 有界结算,快照桥漏配——按同族条款补齐同构计时器。
3. **真实缺陷 B(已修,正是任务行所称"修快照标准 MCP 参数")**:工具 inputSchema 宣告与
   运行时解析漂移——`requestId` 在 `parseFetchRequest` 必填,但 schema 未声明该属性且
   `additionalProperties: false`,合规客户端按 schema 调用**必然失败**;且 annotations 写成
   `idempotent`,全仓其余工具均为 `idempotentHint`(web 端 `McpToolDescriptor` 也按
   idempotentHint 消费)。

**非缺口(不改)**:诊断快照目录的 `entry.dirty` 门(镜像仅在有未保存草稿时发布)是
R12/presence 通道的既定新鲜度合同,不阻断 readback 拉取本身(driver 直接查 readback 存储);
可视 PNG 返回(rgba16float→PNG 转码)涉及转码合同决策,本切片不做,诚实列入剩余。

## 2. 实现

### 2.1 三处真实缺陷的根因修复(均在 `apps/api/src/editorSnapshotFetchBridge.ts`)

| # | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| A | 挂起的 MCP 拉取可永久悬挂 | `request()` 的 Promise 只靠 `prune()` 结算,而 prune 仅由后续 request/takeDriverRequest 触发;浏览器会话死亡(driver 停止轮询)后无人触发,调用悬挂到 HTTP 层超时。同族写事务桥 `EditorSceneTransactionBridge.submit()` 有 setTimeout 兜底,快照桥漏配 | 增加与事务桥同构的 `setTimeout(pendingTtlMs)` 超时结算(含 pending 身份守卫、clearTimeout),超时以 `{status:"unavailable", message:"拉取等待超时"}` 有界落账并进幂等缓存 |
| B | inputSchema 与运行时合同漂移(任务行所称"修快照标准 MCP 参数") | `requestId` 在 `parseFetchRequest` 必填,但 schema 未声明该属性且 `additionalProperties:false`——合规客户端按 schema 构造调用必然失败;annotations 写成 `idempotent`,全仓其余工具均为 `idempotentHint`(web 端 `McpToolDescriptor` 按 idempotentHint 消费) | schema 补 `requestId`(required + pattern,与 REQUEST_ID 正则一致);annotations 改 `idempotentHint` |
| C | MCP tools/call 信封字段错位,**任何合规 MCP 客户端调用 fetch_editor_snapshot 都必然失败** | `callEditorSnapshotFetchTool` 读 `params.input`,而 tools/call 的 JSON-RPC params 是 `{name, arguments}`、工具 schema 声明的字段在 arguments 顶层。既有单测直接调 `bridge.request` 传了合法 input,掩盖了这条从未打通的适配器路径——本批 API 级闭环测试首个失败即暴露此缺陷 | 改读 `params.arguments`(与 `callEditorSceneTransactionTool` 同构);arguments 缺失/非对象时 fail-closed 落「拉取输入不合法」 |

三处均为既有机制的真实缺口,无掩盖性补丁;family sweep 确认仓内其余 `new Promise` 均为
进程/worker/服务器生命周期语义(自带 exit/close 结算),不属于浏览器 driver 轮询桥同族。

### 2.2 API 级闭环测试 `apps/api/src/mcpTemplateVisualLoop.test.ts`(4 例)

不建第二验证平台:全部走既有 Fastify 路由(`inject`),复用
`mcpEditorSceneTransactionBridge.test.ts` 的「MCP inject + driver 轮询并发」范式,
注册 applicationRoutes + editorPresenceRoutes + editorSceneDriverRoutes + mcpCapabilityRoute。

**模板产物作为输入的接线(真实消费,非摆设)**:

- 导入 `templates/deep-engine-3d/templates/01-starter/scene.ts` 的 `createScene()`
  (该文件 import 全部 type-only,运行时零 deep-engine 依赖,纯数据);
- 由模板 RenderPacket 实例(id/transform)映射 studio `SceneSnapshot.models`
  (modelId=实例 id,position/scale 取自列主序 mat4,不写 assetModelId——模板实例是
  RenderPacket 生成件,不引用上传资源,镜像侧已有 `?? modelId` 回退),经
  `migrateSceneSnapshotV1` → POST `/api/projects/default/applications` 持久化
  (assertApplicationDocument + assertSceneAssetReferences 真实校验通过);
- 模拟浏览器渲染模板帧的 readback:rgba16float 64×48(8B/px),字节头写入模板实例名
  签名(可复现、可精确断言往返一致),presence 发布 `diagnosticsSnapshot` 镜像
  (经 parseEditorDiagnosticsSnapshotMirror 真实校验)。

**循环与合同断言**:

1. 主闭环:server/discover → tools/list(fetch 工具存在、schema.requestId 必填、
   resourceId 白名单枚举、idempotentHint)→ resources/list(编辑器资源+场景上下文+诊断目录)→
   resources/read scene-objects(4 个模板实例名全集)→ resources/read diagnostics
   (资源摘要=模板帧元数据)→ GET application(bollard-east 位置=模板 trs(2.6,0.55,1.4),
   模板→studio 文档映射证据)→ 并发 tools/call fetch_editor_snapshot + driver
   snapshot-request/snapshot-result 轮询 → 字节往返逐位一致(dataBase64 全等、byteLength/格式/
   尺寸/frameId 匹配)→ 同 requestId 幂等重放同结果 → 未知会话 fail-closed。
2. 预算合同:maxBase64Chars=64 注入,driver 超预算回传 → `unavailable`「回传载荷不合法或
   超出预算」(fail-closed 不静默截断)。
3. TTL 合同(缺陷 A 回归验证):pendingTtlMs=25ms,driver 死亡 → 挂起调用在超时内有界结算
   「拉取等待超时」;pending 清理(driver 轮询 204);同 requestId 幂等回放超时结果;
   新 requestId 恢复完整循环成功。
4. viewer 拒绝:MCP 路由路径上 viewer 角色调用 → `unavailable`「viewer 角色无诊断快照读取权限」。

### 2.3 范围纪律

- UI 零新增(MCP 为开发者链路,未加任何面板);未触碰 `packages/deep-engine/src/physics/`、
  `docs/specs/jc-i-continuation-20261001.md`(只读);无 cargo;无帧时/性能测量;
  无 commit/push/reset。
- Chrome/浏览器路径未占用(本切片为 API 级模拟 driver,与 F6/T18/E1 无串行冲突)。

## 3. 测试证据(2026-10-03 实测)

- `npx vitest run src/mcpTemplateVisualLoop.test.ts`:**4 passed / 0 failed**(201ms)。
- 同族全家 `editorSnapshotFetchBridge + mcpEditorSceneTransactionBridge + mcpEditorSceneResources
  + editorDiagnosticsSnapshotMirror`:**13 passed / 0 failed**。
- apps/api 全量回归:**Test Files 307 passed | 1 skipped(308);Tests 2198 passed | 23 skipped
  (2221),0 failed**(47.6s)。
- typecheck:`cd apps/api && npx tsc --noEmit` **exit 0**(2026-10-03 实测)。
- 体量门禁:`node scripts/check-source-size.mjs` 现报 22 条超限,全部为既有 Rust 文件
  (`packages/deep-engine-native`、`packages/deep-engine-wasm`、`tools/ps-schema-probe`,
  git status 证实非本批改动);本批两个文件(测试 ~250 行/修复面 ~215 行)不在清单,通过 800 行门。

## 4. 完成度与诚实声明

**已完成**:模板产物→MCP 视觉循环的 API 级闭环(打开场景→渲染帧→readback 拉取→幂等/TTL/预算
合同全断言);三处真实缺陷根因修复;相关测试全绿(闭环 4 例、同族 13 例、apps/api 全量 2198 例)。

**未验证/剩余(如实声明)**:

1. **真实浏览器端到端未跑**:本切片按约定为 API 级模拟 driver;真实 Chrome+WebGPU 渲染模板
   场景、真实 Claude/Codex 客户端握手(stdio/HTTP)未在本切片验证(61 行表 P1 的"Claude/Codex
   实际握手…取消"部分仍开放;Chrome 路径按用户约束与 F6/T18/E1 串行)。
2. **可视 PNG 返回未做**:61 行表 P1 明示"可视 PNG 返回";当前 readback 仍返回原始 base64
   字节(rgba16float 等),rgba16float→PNG 转码涉及 tone-mapping 合同决策,未擅自实现。
3. **显式"取消"未做**:MCP 侧对挂起拉取的显式取消(notifications/cancelled)未实现,
   本批修复的有界 TTL 超时兜底覆盖最坏情形( driver 死亡不再悬挂)。
4. 诊断快照目录的 `dirty` 门(仅未保存草稿发布镜像)为 R12/presence 通道既定合同,未改动;
   若产品要求"打开未修改场景也可列目录",需另行决策。
5. 仓内体量门禁现存 22 条 Rust 文件超限为既有状态,不属本任务行,未处置(避免越权改动
   其他线路的文件);需主线程按所属任务行处置。

