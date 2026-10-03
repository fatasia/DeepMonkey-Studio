# 交接文档：阶段 1 收尾与后续严格规划（交 GLM，2026-10-03）

> 交接方：Copilot 会话（含 20+ 个 claude-sonnet-5.5 子智能体）。接手方：GLM。
> 本文是唯一入口。每个结论都带文件、命令或文档出处；"未验证"的地方会明说，不要当成已完成。
> 配套总方案：[upgrade-plan-ai-native-world-20261003.md](upgrade-plan-ai-native-world-20261003.md)。上一份交接：[handoff-remaining-tasks-20261004.md](handoff-remaining-tasks-20261004.md)（其中 B2/T11、J3-E-GPU、Z2/Z3.5 三行 GPU 批次仍有效，见 §5）。

---

## 0. 一页纸摘要

**定位**：AI 原生可编程三维世界，AI4S 与世界模型承接层。
**目标**：极致性能、优秀效果，对标 Unity / UE / Babylon / 西门子 PS·PD·Plant；同时守住代码质量、引擎包体积、three↔Deep 视觉一致，编辑器性能与交互优先。

| 阶段 | 状态 | 说明 |
|---|---|---|
| 阶段 0（AI 助手简化、默认样例、环境解锁） | 完成 | OrayIdd 已被用户禁用，Chrome WebGPU 与 RTX 4060 实测可用 |
| 阶段 1（性能、效果、体积、一致性） | 约 90%，剩 §3 的 P0/P1 | 见 §2 完成清单与 §3 规划 |
| 阶段 2（World API、助手闭环、模型路由） | 约 90% | World API、模型路由完成；助手"场景改动闭环"完成但有 4 项决策待定 |
| 阶段 3（传感器、批量 rollout、数据集、OpenUSD/科学格式、3DGS） | **用户决定不做** | 不要排期。World API 的传感器只保留 schema 扩展点 |
| 文档（README、文档中心、Wiki） | 完成 | 保护区块逐字节未动 |

**交接时的验证快照**（本会话最后一次实测）：
- `tsc --noEmit`：contracts、deep-engine、world-runtime、server-sdk、apps/api、apps/web **六个包 0 错误**。
- `apps/web` 完整 `vite build` 成功；`node scripts/check-bundle-budget.mjs` 全绿，首屏 JS 306.1 KiB / gzip 98.5 KiB（预算 1855.5 / 527.3）；`dist/assets` 总量 66.4 MB（本轮起点 75.7 MB）。
- `hc6s1-monaco-normal-browser.mjs`（Monaco 常态浏览器验收）全绿，console 无错误。
- `pnpm gate:parity` 与 `node scripts/c8-shared-scene-parity.mjs` 在真 GPU 下通过（见 §2.4）。
- **没有跑完**：`deep-engine` 的**全量** vitest（只跑过 webgpu 定向集）。
- **`apps/web` 全量 vitest（最后实测）**：908 个文件中 904 通过，**5718 例通过、2 例失败**，失败全部在 `src/architecture.test.ts`：`recursively uses public package APIs, including scene-sdk`（:53）与 `keeps raw HTTP transport inside api.ts and documented non-business asset boundaries`（:82）。即本轮有新增代码越过了架构边界（直接引用包内部路径，或在 `api.ts` 之外使用原始 HTTP 传输），**接手后第一件事先修这两条**，见 P0-0。

**Git**：本地已有两个检查点 `e59ce4df`、`c73f1a75`，之后还有未提交改动（见 §6）。**没有 push**，按用户要求保持。

---

## 1. 用户的硬约束（长期有效，必须遵守）

1. **范围**：阶段 3 不做；**不做 Python SDK / Python 客户端 / Gymnasium**；World API 只暴露 MCP、HTTP、JS/TS SDK 三路。
2. **测试范围**：UI/视觉测试**只做深色主题 + 1920×1080**，不做浅色、不做其它尺寸。
3. **许可口径不动**：README 的"许可 / 鸣谢 / 联系我 / 作者的话 / 开头 / 演示视频 / 录屏"保护区块一律不动。中文版 README 写 MIT，英文版、`LICENSE`、`package.json` 写 DMCSL-1.0，三处不一致是已知事实，**用户明确说"许可不动"**，不要"顺手统一"。
4. **Git**：允许本地 commit，**禁止 push**。提交信息带 `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` 仅限本会话产生的提交；GLM 的提交按 GLM 习惯。
5. **质量底线**：性能、效果、体积、架构、代码质量、用户体验六项都要有可量化证据（帧时、像素门、包体积预算、依赖方向、测试、1080p 深色截图）。
6. **工业格式**：自研/开源、内置、本地离线；X_T 写作 **X_T**（扩展名 `.x_t`）；不得把商业 SDK、源 CAD/BIM 软件、云转换设为运行依赖或回退。
7. **工作区规则**（`D:\Documents\bim\AGENTS.md` 等）继续生效：开工前必须做现状核查，禁止重复建设；UI/3D 任务走 `design-taste-digitaltwin`（令牌取 `apps/web/src/styles/base.css`，强调色从 `--accent` 派生，禁止 hardcode）。
8. **用户的工作方式偏好**：消息来了不要中断任务；进度要给百分比；思考与说明尽量中文；不要为省事砍范围。

---

## 2. 本轮完成清单（带证据）

### 2.1 阶段 0

| 项 | 结果 | 出处 |
|---|---|---|
| AI 助手简化 | 头部=标题+会话下拉+"对话/执行任务"分段按钮；"本次上下文"合并为一条折叠行；输入框内置范围与模型下拉；执行任务页重写；面板金色全部改为 `--accent` 派生 | 方案 §4；`AiAssistantPanel.tsx`、`IndustrialAgentWorkspace.tsx`、`platform-pages.css` |
| 默认样例场景 | 新建场景默认带"示例本体"（底座、立柱、行为热点），可选空白；已修：样例原来 `outline:true` 会把 Deep 偏好打回 WebGL，改为 `false` | `controllers/defaultSceneSample.ts`、[default-scene-sample-20261003.md](default-scene-sample-20261003.md) |
| 文档中心顶栏遮挡 | 工作区顶栏 "1920 × 1080" 文字被折叠按钮遮住首位，已修（`dashboardWorkspacePolish.css`） | 1080p 深色截图复核 |

### 2.2 体积

- `ts.worker` 去重：总资产 75.7 → 66.1 MB；只剩 1 份 `ts.worker` 与 1 份 `editor.worker`。
- 过程中发现并修复两个回归：去重后缺 `MonacoEnvironment` 导致 `editorWorkerService` 加载失败（新增 `components/monacoWorkerEnvironment.ts`）；子智能体把 Monaco 贡献改成静态 import，使 3 个测试套件 `window is not defined`，已改回**动态** `loadMonacoCore()`（`professionalCodeServices.ts`）。
- `check-bundle-budget.mjs` 的 `findManifestEntry` 增加按 chunk `name` 兜底（`ViewerEngine` 被合并进共享 chunk 后 manifest 不再带 `src`）。检查逻辑本身没有放宽。
- 详见 [bundle-tsworker-dedup-20261003.md](bundle-tsworker-dedup-20261003.md)。

### 2.3 显示合约与一致性

- `packages/contracts/src/displayContract.ts` 的 `DEFAULT_DISPLAY_CONTRACT` 为 three 与 Deep 的唯一默认值来源（ACES 算子 `three-aces-r185`、曝光 1.05 与动态曝光、GI 缺省 0.32、阴影、AA、bloom）。three 侧映射集中在 `viewer/displayContractThree.ts`。
- 审查缺陷已修：GI 缺省值三处不一致（0.45 / 1 / 0.32）、动态曝光公式硬编码。`displayContractParity.test.ts` 含"缺字段"回归。
- 发布包默认写入合约算子（`compileSceneRuntimePackage.ts`），`compileSceneEnvironment.test.ts` 已同步断言。
- **纠正一个误还原**：GLM 账本已决策"contactShadows 默认开"（[contact-causal-reds-closure-20261003.md](contact-causal-reds-closure-20261003.md)），但 `DEFAULT_PBR_RENDERER_FEATURES.contactShadows` 被早期子智能体改 `toneMapping` 那一行时带回 `false`。已恢复为 `true`，并同步 `pbrCameraProjection.test.ts`、`pbrRendererFeatures.test.ts`。`c8SharedSceneProbe.ts` 显式 `contactShadows:false`（three 侧没有接触阴影，对拍口径要一致）。
- 详见 [display-contract-unification-20261003.md](display-contract-unification-20261003.md)。

### 2.4 像素一致性门 `pnpm gate:parity`

真 GPU（RTX 4060，Chrome WebGPU，深色，320×192）实跑结果：

| 场景 | 档位 | RMSE | ΔE00 均值/p99 | SSIM |
|---|---|---|---|---|
| pbr-matrix | 严格 | 0.258 | 0.02/0.51 | 0.99989 |
| directional-shadow | 严格 | 0.092 | 0.02/0.87 | 0.99995 |
| ibl | 容许（已知缺口） | 4.730 | 0.77/7.72 | 0.98503 |
| transparency | 容许 | 1.497 | 0.20/8.61 | 0.99929 |
| aa-bloom | 诊断（已知缺口） | 6.052 | 0.76/4.68 | 0.99168 |
| bloom-only（诊断） | 严格 | 0.183 | 0.05/1.03 | 0.99989 |

- 已定位根因：aa-bloom=three 的 MSAA×4+SMAA 与 Deep `spatialAa` 边缘算法不同；ibl=预滤波核不同；透明项经核实**产品 three 作者路径是 composer（线性 HDR 混合）**，与 Deep 一致，原"差距"是门里 three 侧口径错误，已改。
- 无 GPU 或只有软件适配器时门 fail-closed。基线来自单一硬件，换 GPU 需 `--calibrate`。
- 出处：[parity-gate-20261003.md](parity-gate-20261003.md)；脚本 `scripts/gate-parity.mjs`、`scripts/lib/parityGate*.mjs`、`packages/deep-engine/lab/parityGate*.ts`。

### 2.5 引擎能力接入

| 项 | 结果 | 文档 |
|---|---|---|
| T12 资产陈旧/再导入/删除影响面 | 已在资产清单可用：陈旧徽标、更新到最新/保持当前、删除前影响面确认；1080p 深色实测 | [t12-asset-revision-wiring-20261003.md](t12-asset-revision-wiring-20261003.md) |
| T14 根运动（平移+旋转） | 已应用到实例；开关与复位 UI；审查缺陷已修（播放头用 `action.time`、零分配、任意轴复位判定） | [t14-root-motion-rotation-ui-20261003.md](t14-root-motion-rotation-ui-20261003.md) |
| T20 粒子 | 曲线 LUT、透明排序、预算（场景总 1024）、曲线编辑器；引擎新增 `particleCurveLut.ts`、`particleSort.ts` 与 `./particles` 子路径 | [t20-particle-consumption-20261003.md](t20-particle-consumption-20261003.md) |
| 体积雾 | 核心早已接入（审计结论过期）；补散射反照率作者入口 | [fog-fixedstep-wiring-20261003.md](fog-fixedstep-wiring-20261003.md) |
| FixedStepClock | 物理宿主改用，60Hz，追赶上限 12；步数量化由 floor 改 round（两处断言 1/120→1/180）；确定性单测齐全 | 同上 |
| 路径追踪 | 多 Worker 分块并行（N=1 与旧实现逐字节一致）、1280/1920 档与内存预算、sRGB PNG+sha256 回执、停止并保留 | [pathtrace-parallel-20261003.md](pathtrace-parallel-20261003.md) |
| 材质补齐 | sheen、iridescence、透射厚度/衰减、clearcoat（含 IBL 项）；选择性变体，stock WGSL 零变化；three 对拍直射相对 RMSE：sheen 0.09%、clearcoat 0.10%、iridescence 2.7%、组合 0.14%；白炉能量守恒通过 | [deep-material-gaps-20261003.md](deep-material-gaps-20261003.md) |
| Deep 描边 | 根因是材质账本对账漏算 bit 256；新增 `postprocess/instanceOutline*.ts`（掩码→半分辨率边缘→合成），零开销；放宽 `useAppRuntimeEffects` 的强制 WebGL 回落 | [deep-outline-20261003.md](deep-outline-20261003.md) |

### 2.6 阶段 2

| 项 | 结果 | 文档 |
|---|---|---|
| World API v1 | `reset(seed)/step/observe/snapshot/restore`；contracts + `packages/world-runtime`（无头 Rapier）+ MCP/HTTP/JS-TS SDK；`observe` 仅位姿、接触、事件、时间；传感器只返回 `unsupported/not-implemented`。审查 9 条缺陷（含 Critical 伪造快照）已逐条修复，1 秒墙钟预算，每用户 4 个 world，60 分钟绝对存活期 | [world-api-v1-20261003.md](world-api-v1-20261003.md)（§4 审查修复） |
| 模型路由与上下文下压 | 总提示 80,185 → 21,535 字符（−73%）；稳定前缀排序；"自动"路由（写操作一律强模型）；上下文预算器按 JSON 值层面裁剪 | [model-routing-cache-20261003.md](model-routing-cache-20261003.md) |
| 助手"场景改动闭环" | 差异预览→整批原子应用（一个撤销单元）→应用后截图+状态核对+模型自检→最多 2 轮修正→一键撤销→审计回执；仅在"执行任务"页，开关默认关 | [assistant-verify-loop-20261003.md](assistant-verify-loop-20261003.md) |

### 2.7 测试债务

- `deep-engine` webgpu 5 例（contactShadows 默认值与默认算子变更）已清零。
- 桥测试 2 例：`StudioDeepWebGpuBridge.pumpProbeCapture` 无条件武装 RAF，改为先判断 `probeClipmapEnabled()`（真实小优化）。

### 2.8 文档

- README / README.en：功能亮点与完整功能列表重写，新增"环境、效果与出图""数字孪生场景搭建"分组；核查并更正多处旧文不准（Tool Harness 能力范围、Docker 一键部署只含 PostgreSQL+MinIO、`.env` 示例 sqlite/json 不一致等）。保护区块 sha256 前后一致。出处 [readme-feature-audit-20261003.md](readme-feature-audit-20261003.md)。
- 文档中心：新增 `scene-effects-rendering`；重写 6 篇、局部修订约 18 篇；新增"渲染引擎"分类，`DOCS_VERSION` 升至 `2026.10`；渲染器不支持 `**粗体**`，8 篇共 45 行星号已清理。Wiki 33 篇 `pnpm docs:wiki:check` 通过。出处 [docs-center-audit-20261003.md](docs-center-audit-20261003.md)。
- 1080p 深色截图复核 `/docs`、`/docs/scene-effects-rendering`、`/docs/getting-started` 排版正常。

---

## 3. 严格规划：后续任务

**执行规则**：每项开工前做"六步现状核查"并把"已有 / 真实缺口"写进该项文档；每项收尾必须给出验收证据（命令输出或 1080p 深色截图）；**同一时间不要开多于 4 条并行线**（本会话 8–9 条并行时，构建被互相的在途文件反复打断，浪费大量时间）。

### P0：先清零风险（预计 0.5–1 天，不并行）

| # | 任务 | 动作 | 验收标准 |
|---|---|---|---|
| P0-1 | 全量测试基线 | `cd apps/web && npx vitest run`；`cd packages/deep-engine && npx vitest run`；`cd packages/contracts && npx vitest run`；`cd apps/api && npx vitest run` | 失败清单落盘；每个失败归类为"本轮引入 / 既有 / 超时" |
| P0-2 | WGSL 校验和漂移 | 已知失败：`c8F32Inputs`、`j3DFullLayerMatrix`、`iesSamplingWgslChecksum`、`materialMetalReflectionSampling`（65536 样本 CPU 积分，6.9s 超时）。先 `git log -p` 查是谁改了生产着色器源；本轮材质补齐声称 stock WGSL 零变化，需验证 | 校验和漂移要么是有意变更（更新金样并记账）要么回滚；超时用例调 timeout 或降样本 |
| P0-3 | 默认样例在 Deep 下可创建 | 本会话临时测试证明 `sceneSnapshotToRenderPacket` 对样例 3 个基础体**不抛错**（已通过）。但 deep-outline、路径追踪两个子智能体都曾报 `基础体 sample-pedestal 的材质需要适配:clearcoat`，判断为材质子智能体改动期间的瞬时状态。**需在真编辑器里复验一次**：新建场景（默认样例）→ 切 Deep WebGPU → 1080p 深色截图，且不报错 | 截图证明 Deep 下底座、立柱、热点都显示；无"材质需要适配" |
| P0-4 | 描边实时勾选退步 | 独立 packet 路径下实时勾选"轮廓"在 Deep 视口不立即显示（[deep-outline §6-1](deep-outline-20261003.md)）。让描边集合变化走 `updateInstances` 的 `outline` 位（≤1 帧可见，不重建 packet）；首次描边的 4 条管线改异步预热 | 单测：描边位变更不重建 packet 资源；真编辑器 1080p 深色截图：勾选即出现 |
| P0-5 | 含动画/蒙皮的模型进不了 Deep | 实测：场景"真实模型与引擎演示"（5 个真实模型）切 Deep 失败，`animations: Unsupported animations.`，来源 `decodeGltf.ts:31` 静态子集拒绝 `animations/skins`，经 `compileSceneRenderPacket.ts` 的 `decodeTexturedGlb`。Deep 已有 `decodeAnimatedGlb`、`decodeMorphGlb`、`deformationProjector`（`allowDeformation`）、T14 蒙皮演员，编辑器路径未接。**本会话子智能体 `deep-animated-models` 已启动但未收尾、没有写文档，状态未知**：先 `git status` 看 `apps/web/src/delivery`、`packages/deep-engine/src/gltf`、`threeBridge` 的未提交改动，决定接续还是回滚 | 复现命令：`cd apps/web && STUDIO_SCENE_ID=776cf382-8d4b-4740-8de4-167d1d4d4632 FAIR_OUTPUT_DIR=…\test-output\deep-fair-comparison-20261003 node scripts/gate-deep-fair-comparison.mjs`；Deep 下动画播放，不再整场景切换失败；不支持的子集只降级该模型并提示 |
| P0-6 | 清理开发库测试数据 | 项目 `38ea81ba-…` 里有验收脚本保存的若干"未命名场景"（"智造综合案例验证"库） | 删除后场景列表只剩用户数据。删除接口：`/api/auth/login` 取 token → `DELETE /api/projects/<pid>/scenes/<id>` |

### P1：阶段 1 的真缺口（预计 3–5 天，最多 3 线并行）

| # | 任务 | 说明 | 验收标准 |
|---|---|---|---|
| P1-1 | 高级材质编辑器 UI 与持久化 | `SceneMaterialState` 的 clearcoat/sheen/iridescence/transmission 新字段目前**只有合同与校验**；UI、保存/撤销重做/复制、three `MeshPhysicalMaterial` 投影、`rendererCapabilityManifest` 登记、native/runtime package 的 `advancedParameters` 都没做。变体在 Deep backend 创建时判定，之后新开启 lobe 会被桥拒绝——需受控重建或提示。本会话子智能体 `deep-material-gaps` 正在做"编辑器接入"，**未收尾**：先看 `docs/specs/deep-material-gaps-20261003.md` 末尾是否有"编辑器接入"小节 | 面板"高级材质"折叠分组（默认收起）；同一材质在 three 与 Deep 视觉一致（用 `npm run test:advanced-material-three-parity`）；1080p 深色截图 |
| P1-2 | 帧时与 GPU 时间戳 | rAF 指标受 vsync 限制（144Hz 显示器上 p50 恒为 7ms），区分不出 GPU 余量。真机基线：1080p/1000 对象/阴影+特效全开，WebGL 与 WebGPU p50 14ms、p95 21ms，**p99 WebGL 74ms vs WebGPU 26ms**，draw 仅 102–105。补 WebGPU timestamp-query 的逐 pass GPU 时间，进 `gate-viewer-performance-audit.mjs` | P95/P99 GPU ms 入证据文件；目标：1080p/1000 对象 p95 ≤ 16.7ms |
| P1-3 | Z2/Z3.5 真机验证 | `contactShadows` 已默认开。要在真机验证帧时代价（`shadows/contactShadowQuality.ts` 三档质量）与回退；softness knob 扩展（quality 档 0.35 / performance 档 0） | 三档帧时表；回退路径单测 |
| P1-4 | B2/T11、J3-E-GPU | 沿用上一份交接 §2；GPU 已解锁，可以开跑。前置门：J3-E probe §6.3 对拍通过前统计批禁跑 | 见 [handoff-remaining-tasks-20261004.md](handoff-remaining-tasks-20261004.md) §2 |
| P1-5 | 像素门接 CI 与扩面 | 现仅本机运行，基线单一硬件。扩面：纹理采样、点光/聚光阴影、雾、AO/SSR；ibl 与 aa-bloom 两个"已知缺口"若要升档需改 Deep 预滤波核或 AA 算法 | `pnpm gate:parity` 进 CI（需 GPU runner）或明确为本地手动门并写入 CONTRIBUTING |
| P1-6 | 路径追踪补完 | 编辑器内真实 E2E 未跑通（被瞬时 lobe 改动挡住，需复测：`更多 → 导出场景 → 物理光照出图`，材质需勾"双面"）；渲染前吞吐标定；Worker 初始化失败自动减半重试 | [pathtrace-parallel §收尾与交接](pathtrace-parallel-20261003.md) 的 4 条动作 |
| P1-7 | 粒子 GPU 路径 | `PbrParticlePass` 的 GPU 排序核、曲线 LUT 纹理、事件读回、烟体接线未做；WebGPU 渲染器下 `THREE.Points` 不支持逐粒子尺寸，size 曲线退化为均值；场景预算 1024 为常量无设置入口 | [t20 §遗留](t20-particle-consumption-20261003.md) |

### P2：阶段 2 的决策与收尾（预计 2–3 天）

需要用户或 GLM 主线程**先裁决**的 4 项（来自 [assistant-verify-loop §交接](assistant-verify-loop-20261003.md)）：
1. "场景改动"开关是否对 Studio 默认开启（现默认关）。
2. 修正轮次默认 2、上限 3 是否合适。
3. 自主执行下 `animation`、`data`、`component` 类命令是否免确认。
4. 审计是否进 `provenanceLedger`。

| # | 任务 | 说明 | 验收标准 |
|---|---|---|---|
| P2-1 | 助手闭环补完 | 模型直接看图（`SceneEditAsk` 加 `images`，`verify` 传 `shot.dataUrl`，api 侧 `assistantService`/`openAiCompatibleProvider` 支持图片入参）；`set-parent` 前值读取口；三个错误态（回滚、前值失效、栈顶被改）的浏览器截图；`gate-agent-scope.mjs` 过时断言（`entry.contrast.length >= 5`）同步 | 深色 1080p 截图 + 新增 `gate-scene-edit-loop.mjs` |
| P2-2 | Agent 决策器预算 | `IndustrialAgent` 决策器仍是"80k 字符超限即拒绝"，应改为同款预算裁剪 | 复用 `assistantContextBudget.ts`；单测 |
| P2-3 | 路由收尾 | 管理页展示缓存命中率与小模型配置表单；chat 流式请求 `include_usage`；`SOURCE_PATHS` 的 `workspace-scene` 与 Web 实际 `workspace.scene` 对不上 | 单测 + 管理页截图 |
| P2-4 | World API 补强 | viewer 角色实际用不到 observe/snapshot（世界归属是创建者，需"世界共享"才可用）；通用能力路由对同一次调用重复写审计；`traceHash` 未接 provenance 账本；同步 `step` 阻塞事件循环（现靠 1 秒预算兜底，根治=worker thread 或分段让出） | 逐条有单测；写入 world-api 文档 §4 |
| P2-5 | 源码体量 | `apps/web/src/App.tsx` 878 行（超 800 行门槛，基线 862，助手闭环 +16）；`ts.worker` 与 `SceneBehaviorPanel`（3.5MB）等懒加载大块可再评估 | `App.tsx` 回到门槛内；体积预算不回退 |

### P3：对标 Unity/UE/Babylon/西门子的长期项（上一份交接 §3 批次 2 仍有效）

沿用 [handoff-remaining-tasks-20261004.md](handoff-remaining-tasks-20261004.md) §3 的顺序：T24 backfill（OPC UA Historical Access）与数据质量视图、T08/T09 六工作包、D3 差分更新/签名/可回滚发布、`materialLosses` 传播、T17 collider 来源选择器、J3-E 残项。其中 T20、T14、T12、outline 四项**已在本轮完成或部分完成**，请在该文档里同步标记。

---

## 4. 接手第一天的操作清单（按顺序，不要跳）

1. **看现状**：`git --no-pager log --oneline -5`；`git status --short | wc -l`（本会话收尾时约有数百项未提交，多会话共享）；`git --no-pager diff --stat HEAD | tail -3`。
2. **类型检查六包**：
   ```powershell
   foreach($p in 'packages/contracts','packages/deep-engine','packages/world-runtime','packages/server-sdk','apps/api','apps/web'){ Push-Location $p; npx tsc --noEmit -p . ; Pop-Location }
   ```
   重要：Vite 的 Worker 子构建走 `packages/*/dist`（无 `development` 条件），**改了 contracts 或 deep-engine 源码后必须重建 dist**，否则 `vite build` 报 "missing export"：`cd packages/contracts && npm run build`、`cd packages/deep-engine && npm run build`。
3. **构建与预算**：`cd apps/web && npx vite build && node scripts/check-bundle-budget.mjs`。
4. **全量测试**：见 P0-1。
5. **GPU 自检**：`node` 跑 [handoff-scripts-20261003/gpu-probe.mjs](../handoffs/handoff-scripts-20261003/gpu-probe.mjs)（需 dev server 在 5173，用 `http://127.0.0.1:5173/` 作为安全上下文；`about:blank` 下 `navigator.gpu` 为空是正常现象）。期望输出 `{"ok":true,"info":{"vendor":"nvidia","architecture":"lovelace"...}}`。
6. **一致性门**：`pnpm gate:parity`（约 3 分钟）、`node scripts/c8-shared-scene-parity.mjs`（约 90 秒）。
7. 再开始 P0 各项。

### 环境要点

- dev server：Web 5173、API 4100（用户自启动）；登录 `admin/admin`。
- Chrome：`C:/Program Files/Google/Chrome/Application/chrome.exe`；playwright-core 取自 `apps/cloud-render-worker/node_modules`（用 `file:///` URL 导入）。启动参数 `--enable-unsafe-webgpu`；后端偏好：`localStorage["bim-studio.renderer-backend"]="webgpu"`（默认缺省回落 WebGL，Deep WebGPU 仍标 Beta，这是有意设计）。
- OrayIddDriver 已被用户禁用（问题码 22）。若日后被远控软件重新启用，WebGPU 会再次失效；恢复命令见上一份交接 §1。
- 可复用脚本已拷贝到 [docs/handoffs/handoff-scripts-20261003/](../handoffs/handoff-scripts-20261003/)：`gpu-probe.mjs`、`editor-frametime.mjs`（真编辑器 WebGL vs WebGPU 帧时）、`sample-shot.mjs`（新建样例场景并截图）、`ai-shot.mjs`（AI 助手面板截图）、`cleanup-scenes.mjs`（按名字前缀清理测试场景；注意鉴权是 Bearer token，不是 cookie）。**这些脚本会在项目里创建场景，用完务必清理。**
- PowerShell 注意：`Set-Content` 单元素数组展开会把文件改乱（世界 API 子智能体踩过一次）；批量替换后务必 `git diff` 核对。

---

## 5. 已知风险与技术债（按影响排序）

1. **多会话共享工作树**：本轮同时有 8–9 个子智能体改同一棵树，出现过：语法错误的在途文件阻塞他人构建；一个子智能体误还原另一方的默认值（contactShadows）；`dist` 过期导致 Worker 子构建失败。接手后**避免多线并发改同一包**，改完立刻 tsc。
2. **`deep-animated-models` 与"高级材质编辑器接入"两条线未收尾**，且 `deep-outline` 的"实时勾选"追加修复也未收尾。它们的半成品状态以 `git status` 与对应文档为准；如发现不可构建，优先手工还原到 `c73f1a75` 之后的稳定点，不要硬修。
3. 一致性门基线单一硬件；`gate:parity` 未进 CI。
4. 路径追踪：开发服务器下 ≥8 个 module Worker 并发加载未打包依赖会 `ERR_INSUFFICIENT_RESOURCES`（仅 dev）；`PathTraceAuthorDialog.test.tsx` 用 `useState/useRef` 位置式 mock，改 hook 顺序会使测试错位。
5. World API：不支持关节/软体物理；无跨机器确定性证据；快照不做 HMAC 签名（设计取舍：需跨进程可移植；若产品要求"只允许 restore 本服务签发的快照"，可再叠加签名）。
6. 描边：变形（pose）与 meshlet 批次不进掩码；描边 pass 私有、未接 frame-graph、J4 能力清单未登记 `instance-outline`；云渲染 Worker 的描边实机回归没做（`publicationRendererPolicy.ts` 已放宽对象级描边不再强制 WebGL 发布）。
7. 材质：贴图 lobe、各向异性、色散不支持；透射只折射环境；只有主太阳光得到 sheen/iridescence/clearcoat 直射项；three 对拍只做了直射，IBL 因 PMREM 与 Deep 预滤波环境未对齐未对拍；iridescence 相对 RMSE 2.7% 集中在少数像素，未深究根因。
8. 其它：`probe-bake` 在新场景上返回 404（"未命中=无"的既定契约，客户端按未烘焙处理，浏览器控制台会出现一条 404，属预期）；`.zcodeignore`、`REPORT-2026-09-24.md` 等仓外文件不要动。

---

## 6. Git 与文件清单

- 已提交：`e59ce4df`（阶段 0 与阶段 1 首批）、`c73f1a75`（阶段 1 接线、审查修复、并行门、Monaco 修复）。
- 本交接前最后一次提交见 `git log`；之后的改动含：World API 审查修复、模型路由、助手闭环、路径追踪并行、材质补齐、描边、README/文档中心/Wiki、本文档。
- 本地 `.git/info/exclude` 已加入 `release-assets-v0.1.0/`、`release-staging-v0.1.0/`、`node-raster-test-*/`（含 400+ MB 安装包，勿入库）。
- 新增 package：`packages/world-runtime`。

## 7. 证据索引

阶段 0/1/2 全部规格都在 `docs/specs/*-20261003.md`，每份末尾有"实施结果 / 审查修复 / 交接"小节；关键测试输出在 `test-output/`（`parity-gate/`、`advanced-material-gpu-20261003/`、`deep-fair-comparison-20261003/`、`t12/`、`hc6s1-monaco-20261003/`）。

| 主题 | 文档 |
|---|---|
| 总方案 | [upgrade-plan-ai-native-world-20261003.md](upgrade-plan-ai-native-world-20261003.md) |
| 体积 | [bundle-tsworker-dedup-20261003.md](bundle-tsworker-dedup-20261003.md) |
| 显示合约 / 一致性门 | [display-contract-unification-20261003.md](display-contract-unification-20261003.md)、[parity-gate-20261003.md](parity-gate-20261003.md) |
| 引擎接入 | t12 / t14 / t20 / fog-fixedstep / pathtrace-parallel / deep-material-gaps / deep-outline（均 `-20261003.md`） |
| 阶段 2 | [world-api-v1-20261003.md](world-api-v1-20261003.md)、[model-routing-cache-20261003.md](model-routing-cache-20261003.md)、[assistant-verify-loop-20261003.md](assistant-verify-loop-20261003.md) |
| 文档 | [readme-feature-audit-20261003.md](readme-feature-audit-20261003.md)、[docs-center-audit-20261003.md](docs-center-audit-20261003.md) |
| 上一份交接 | [handoff-remaining-tasks-20261004.md](handoff-remaining-tasks-20261004.md)、[omission-audit-20261004.md](omission-audit-20261004.md) |
