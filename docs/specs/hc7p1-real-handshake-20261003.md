# H-C7-P1 真实握手联调交付报告：MCP 真客户端握手 + 真浏览器 driver + 可视 PNG 返回

日期：2026-10-03。接续：`docs/specs/hc7p1-mcp-template-loop-20261003.md`（早批 API 级闭环 4/4 绿、
三处真缺陷根因修复）。本刀闭合该报告 §4 声明的剩余项 1（真实浏览器端到端）与项 2（可视 PNG 返回）。

## 1. 现状核查（六步）

**已有（复用，不重建）**：

1. `apps/web/scripts/isolatedStudioGate.mjs` 骨架（隔离端口/数据目录/产品静态服务/登录上下文）；
   `createProductServer` + `onlineFlowAuditSupport.mjs`（reservePort/waitForHealth/captureProcessOutput）。
2. Web 真实 driver：`useEditorPresence.ts`（1s 轮询 `snapshot-request`/写事务 `next`，64MB 字节预算，
   0x8000 分块 base64）+ `readStudioFrameReadbacks()` 有界 readback 历史（8 条）。
3. MCP 路由 `/api/mcp`（`mcpCapabilityAdapter.ts`）：modern 协议头合同
   （`mcp-protocol-version: 2026-07-28` + `mcp-method` + tools/call 时 `mcp-name`）；
   `fetch_editor_snapshot`（早批已修 requestId schema/`params.arguments` 信封/超时兜底）。
4. 诊断 readback 产出链：诊断面板 `useRendererDiagnostics` → `setStudioFrameCaptureRequested(true)` →
   `StudioDeepWebGpuBridge` backend 创建时挂 `frameCaptureSession`（present-color + linear-depth 每帧
   readback）→ `createStudioFrameReadbackListener()` 进有界历史。
5. 可视 PNG 的仓内既定转码合同：`apps/web/src/viewer/frameReadbackPng.ts`
   （`frameReadbackPixelsRgba8`：Reinhard per-channel tonemap，注释明示"diagnostic preview only,
   never a match for the renderer's ACES path"——**tone-mapping 合同已决策，本刀遵守不动**）。
6. 场景打开/编辑 UI 范式：`gate-jt-material-visual.mjs`（UI 新建场景 + workspace PUT + studio 深链接）。

**真实缺口**：真实 Chrome（WebGPU）渲染模板派生场景 + 合规 MCP 客户端 + 真浏览器 driver 的全链
联调零覆盖；readback 字节→可视 PNG 的 MCP 侧证据零覆盖。本刀新建
`apps/web/scripts/gate-hc7p1-real-handshake.mjs` 闭合，**零 src 文件改动**。

## 2. 实现

### 2.1 联调脚本结构（`apps/web/scripts/gate-hc7p1-real-handshake.mjs`）

隔离 gate（独立端口/数据目录/`BIM_STUDIO_E2E_EPHEMERAL`）+ Playwright Chrome
（`--enable-unsafe-webgpu --enable-features=Vulkan,UseSkiaRenderer --no-sandbox`，
deep-gpu-stage-smoke.mjs 同款先例）。链路时序（每一环都是实测卡点）：

1. **场景（模板产物为输入）**：UI 新建场景（常规文档加载路径）→ 模板 01-starter 四实例映射为
   primitives（pedestal/crate box + bollard-east/west cylinder，模板 TRS 与材质色，与 API 级测试
   同源同值）经 workspace PUT 写入 → studio 深链接 `?renderer=webgl` 打开。
2. **readback 时序合同**：诊断 readback 只在 deep backend **创建时**挂载（`frameCaptureSession`
   随 backend 生成，面板后开无法补挂）——先开诊断面板（`requested=true`）再切 Deep WebGPU，
   backend 重建于 requested=true 后 readback 生效（面板实见"21 帧"）。
3. **合规 MCP 客户端**：Playwright request + bearer，JSON-RPC 2.0 信封，现代协议三头。
4. **写事务**：`editor.scene-transaction`（`object.set-transform` 移动 crate 至 (0.6,1.05,0)）→
   真浏览器 driver 取走执行 → committed；每次重试经 resources/list 取最新 uri（内嵌当前
   draftRevision），规避引擎重建期 viewer 未就绪与 revision 推进。
5. **fetch 全链**：tools/call `fetch_editor_snapshot`（present-color）→ 服务端挂起 → 页面内
   `useEditorPresence` 1s 轮询取走 → readback 字节 base64 回传 → MCP 响应。
6. **可视 PNG（Node 侧 CPU 光栅）**：`rgba16float` half-float 解码 + **Reinhard tonemap**（与
   `frameReadbackPng.ts` 逐式同构，指明来源）+ 手写 PNG 容器（IHDR + IDAT(deflate) + IEND，
   内置 zlib）落盘。不依赖页面存活，符合服务商故障时的 CPU 光栅处置。

### 2.2 调试过程中确证的行为事实（如实登记，零 src 改动）

| # | 行为事实 | 定性 |
|---|---|---|
| A | 编辑器资源 uri 为 `studio://active-editor/{sessionId}?revision=N`；`editor://session/...` 仅用于场景/诊断子资源 | 文档化差异，无缺陷 |
| B | **MCP 写事务经引擎端口执行后，React draft 未标记 dirty**（`sceneMetadataDraftPatch` 仅回写场景级元数据；object 变换不回写）→ dirty 门使诊断目录不发布 | 跨线行为边界，属 H-C7-P4 场景事务 draft 回写职责；对 fetch 无影响（driver 直读 readback 历史） |
| C | 诊断目录受 dirty 门 + autoSave 交互影响，在真实编辑流下为**瞬态**（clean→不发布；dirty→发布→autoSave 保存后 dirty 翻回） | R12 presence 通道既定新鲜度合同（早批报告 §1"非缺口"项），fetch 不依赖 |
| D | `?renderer=webgpu` query 在 GPU 在场时无必要——零配置默认即 Deep WebGPU（`initialRendererBackend`），页面并存 three.js 兜底画布与 `data-renderer-backend="deep-webgpu"` 画布 | 零配置默认行为证实 |
| E | rendererSwitching 期间（引擎重建）写事务 viewer 未就绪，事务返回 `failed`"场景视口未就绪"；draftRevision 在切换期会推进 | 引擎重建期合同，事务桥 fail-closed 正确 |

## 3. 全链证据（2026-10-03 实测，29/29 断言通过）

证据目录：`test-output/runs/2026-09-05/hc7p1-real-handshake-gq828C/`（report.json 含断言全清单与哈希）。

**握手与目录**：server/discover（版本含 2026-07-28）、initialize（serverInfo=bim-industrial-core）、
notifications/initialized（204）、tools/list（fetch_editor_snapshot 的 requestId required+pattern、
resourceId 三资源白名单、idempotentHint；editor.scene-transaction 在列）、resources/list（活跃编辑器
会话出现、sessionId 可解析）。

**写事务（真 driver 执行）**：committed；crate 实际移动——**PNG 中 crate 位置偏离中轴可见**。

**fetch_editor_snapshot 全链（真浏览器 driver）**：

- present-color：`frame-28`、`rgba16float`、728×668、`byteLength=3,890,432`（= bytesPerRow 5,824 × 668，
  GPU 行对齐 ✓）、base64 解码全等、非全零；sha256=`4dd6b67f9e59f82d2617d946ec6a4fb5a3bbe2c83b0637ed827c9f8c0d82e4cf`。
- 幂等：同 requestId 重放 dataBase64 全等；frameId 精确拉取命中同帧同字节。
- fail-closed：不存在 frameId → `unavailable`"没有匹配的快照"（真 driver 判定）。
- 并发双发：先发被"被更新的拉取请求取代"（服务端有界结算），第二个正常回传。
- linear-depth：`frame-28`、`r32float`、1,945,216 字节真实回传。

**可视 PNG**：`present-color.png`（85,285 字节，sha256=`ccef8877d0d2783787aa935e2b2830a26a0e80b5c18e49cd6059e77bec01439f`），
魔数+IHDR 尺寸=728×668；**人工可视复核通过**——蓝色 crate（MCP 事务后位置可见）、双琥珀 bollard
（emissive）、暗色 pedestal、地面网格与轴线完整可辨。截图：`studio-webgpu-diagnostics.png`
（当前渲染后端=Deep WebGPU Beta、nvidia·lovelace 适配器、GPU P95 0.4ms）、`studio-final.png`。

**模板→文档映射**：GET application 场景 primitives 四实例全集，bollard-east 变换 (2.6, 0.55, 1.4) 与
模板 trs 同值。

**回归**：`apps/api` `mcpTemplateVisualLoop.test.ts` 4/4 绿（1.05s）；本刀零 src 改动，无其他回归面。
体量门禁：新脚本约 470 行（.mjs 工具脚本，非 src 800 行门范围）。

**服务商故障通报的回应**：协调者通报系统级 D3D12 故障（三浏览器 navigator.gpu 不存在）。本机隔离
gate 实测与此不符——nvidia·lovelace 适配器在探测清单中可见、Deep WebGPU Beta 为当前后端、GPU P95
0.4ms、每帧 readback 产出 21 帧（均为截图与运行日志实证）。处置上两条腿走路：真实 WebGPU 链路已用
实证跑通并落证据；PNG 转码同时按处置③做成 Node 侧 CPU 光栅（不依赖 GPU/页面存活），环境再障时可
独立复现 PNG 环节。若后续运行撞上 GPU 消失，脚本将在 readback 等待处明确失败（不静默降级），按
登记流程转为"待环境恢复"。

## 4. 完成度与诚实声明

**已完成**：真实 Chrome（Deep WebGPU）渲染模板派生场景 + 合规 MCP 客户端（现代协议三头 JSON-RPC）+
真浏览器 driver（useEditorPresence 轮询）的 fetch_editor_snapshot 全链联调（握手/工具目录/写事务/
字节往返/幂等/frameId 精确/fail-closed/并发取代/双资源），29/29 断言；可视 PNG 返回（Node CPU 光栅，
与仓内 Reinhard 诊断导出合同逐式同构）落盘并人工可视复核；dirty 门合同与行为边界 B/C 登记。

**未验证/剩余（如实声明）**：

1. **真实 Claude/Codex 客户端进程未接入**：本刀的"合规 MCP 客户端"是按已修 schema 构造的
   JSON-RPC 客户端（Playwright request），未跑 stdio/HTTP 的 Claude/Codex 桌面客户端实测
   （61 行表该子项仍开放，需真实客户端凭据与环境）。
2. **显式取消（notifications/cancelled）未实现**：沿用早批声明，最坏情形由 pending TTL 有界结算覆盖
   （本刀实测了"被更新的拉取请求取代"路径）。
3. **opaque-hdr 资源未拉取**（白名单第三资源）：当前管线 readback 请求只含 present-color/linear-depth
   （bridge 322 行），opaque-hdr 无产出源，拉取将返回"没有匹配的快照"——与白名单声明一致，未重复断言。
4. **诊断目录在真实编辑流下的瞬态**（行为 C）未做产品决策：若要求"打开未修改场景也可列目录"或
   "MCP 事务后目录立即可见"，需另行决策（后者牵 H-C7-P4 draft 回写）。
5. **viewer 角色拒绝**未在真实浏览器重测（API 级闭环已覆盖，真实环境需 viewer 账号，成本大于增量）。
6. **PNG 转码为客户端侧行为**：MCP 响应携带源字节（dataBase64）即合同本体；服务端未新增转码
   （tone-mapping 合同不动）。PNG 的 Reinhard 与渲染器 ACES 呈现存在色差，属诊断导出既定定位。
7. 环境依赖声明：D3D12/GPU 驱动状态随 Chrome 更新/虚拟显示设备波动（协调者通报），本批证据绑定
   2026-10-03 运行时点；复跑请以脚本 fail 点为准如实登记。

## 5. 范围纪律

无 cargo（apps/api `npm run build` 的既有依赖链编译了 deep-engine-native，非本刀主动 Rust 操作，
无任何 Rust 文件改动）；无帧时/性能测量（诊断面板性能读数仅为环境截图证据，非测量产出）；无
commit/push/reset；未触碰 `packages/deep-engine/src/physics/`、`apps/web/src/ai/`、
`rendererCapabilityUserFace*`、`apps/api/src/editorSnapshotFetchBridge.ts`（本刀零 src 改动）、
`docs/specs/jc-i-continuation-20261001.md`（只读）；Chrome 无其他浏览器线并行。
