# 2026-09-19 主线交接

> 当前收尾交接以 [`codex-mainline-handoff-2026-09-19-closeout.md`](codex-mainline-handoff-2026-09-19-closeout.md) 为准；本文件保留本轮早期状态快照。

## Goal of next session

继续完成用户设定的八项遗留任务，并以机器可读证据、报告和恢复总账收口：

1. 剖切 E2E
2. 动态场景运行包
3. V11 Nature Kit 素材验收
4. 发布链 OS 级证据
5. GI 跨端一致性
6. D24–D28 项目级后验收
7. 工业 S1–S6
8. DE26 资产/readiness

当前目标保持 active。已通过的条目从后续待办中移出；未满足门槛的条目保留原状态，不以报告存在替代验收。

## State of play

进度快照见 [`docs/codex-mainline-progress-2026-09-19.md`](codex-mainline-progress-2026-09-19.md)：当前机器闭环为 3/8 通过、5/8 partial、0 blocked；①④⑤已通过，其余项目的高成本缺口集中在真实产品链、跨端播放和项目级后验收。

主线收口校验器已纳入八项：`node scripts/verify-mainline-closure.mjs` 当前结果为 `passed=3`、`passed-with-boundary=0`、`partial=5`、`bounded-deferred=0`、`blocked=0`，合同有效但八项尚未完成。

| 编号 | 当前状态 | 已确认事实 | 下一证据缺口 |
|---|---|---|---|
| ① 剖切 E2E | **passed** | Native 双变体双轮通过；`changedBytes=299000`（7.79%），裁切和平面差异均有证据。 | 已从待办移出。若后续改动触及场景发布或相机，只需回归同一证据脚本。 |
| ② 动态场景运行包 | **partial** | 已冻结 `deep-engine.dynamic-runtime` v1，并接入 Runtime Package v7 `dynamic-runtime` resource/entrypoint、TRS 编译映射、Native PlayerContent 消费；新增 Web `dynamicRuntimePlayback.ts`，编译器测试实际走“编译产物→entrypoint 校验→TRS 采样→帧应用”，动态解析/采样 4 项与 PlayerContent carry 测试通过。 | 补 WebGPU/Native 真窗口播放、发布实窗和确定性跨端重放证据；不能只删除 deferred。 |
| ③ V11 Nature Kit | **partial** | 48 个候选模板、缩略图审计、素材 SHA、grounded 派生件和后端目录均通过；真实浏览器门禁已完成 Nature 导入、项目资产插入、保存、刷新重开及 1024px 响应式检查；场景资源面板已接入资产专用 MIME、模型卡 draggable 和受信 drop target。 | 本轮真实 `dragTo` 已执行但未形成场景插入持久化证据；按钮路径仍是主验收证据，不能把拖拽尝试升级为通过。 |
| ④ 发布链 OS 级证据 | **passed** | 四窗口像素一致、API 停止后无 sidecar、六次隔离启动退出 0；本机模拟无网链路通过。 | 不再把 clean-machine 防火墙作为本项目硬门槛。 |
| ⑤ GI 跨端一致性 | **passed** | r14 当前 debug Native 播放器双格：on normalized SSIM 0.999376 / MAE 0.005833 / edge F1 1.0；off normalized SSIM 0.986417 / MAE 0.007929 / edge F1 0.999169。Web 点光按 Native 同合同校准为 2.35，原始 SSIM on/off=0.994162/0.997363。 | 复杂几何扩展矩阵仍可增强，但不阻塞本项目既定双格收口。 |
| ⑥ D24–D28 项目级后验收 | **partial** | A04/A08 配对证据和项目后验收映射已存在。 | 仍缺 independent multi-asset、cross-end、long-stability、full-channel 证据；配对案例不等于整卡通过。 |
| ⑦ 工业 S1–S6 | **partial** | 阶段矩阵和报告已入库；聚焦 API、Tiles/X_T、RVT 真实语料测试通过，另已绑定 6 阶段/26 份报告的字节数与 SHA-256；profiles 仍按 inspect/preview 边界处理。 | 补混合场景、干净 OS、版本矩阵和剩余格式 profile 证据；保持 `X_T`/`.x_t` 拼写及 builtin-only 约束。 |
| ⑧ DE26 资产/readiness | **partial**（readiness 内部为 `unverified`） | 8 个场景角色清单、manifest/identity、轨迹、source hash、缓存和许可边界已测量；load class 6/6、task kind 4/4，真实电池 GLB animation fixture 已登记；BIMFACE 源报告已做 SHA 校验并绑定 manifest。 | 本次两个下载文件为同一 SHA，只算一份 BIMFACE 2017/unsupported-version 样本；不覆盖 Snowdon，两个源的完整几何统计仍缺。 |

本轮还修复了开放素材同步的 404 处理：旧 `city-kit-industrial` 直链返回 404 时从 Kenney 资产页解析当前 ZIP，并让单包失败不阻断其他包。17 个包已复跑，缓存约 87.7 MiB。相关代码和报告见“Artifacts”。

## Open decisions

下一位执行者按以下顺序推进，不需要重建已有证据：

1. **动态运行包消费**：复用已完成的 v7 resource/entrypoint 和 Native 解码，继续补编译器映射、播放消费者及确定性实窗证据。
2. **V11 产品验收**：使用 manifest 中 48 个候选和 grounded 派生件，实证目录导入、当前可用的项目资产插入按钮、保存、刷新、重开；真实拖放暂不宣称。若要升级门槛，先实现资产卡→场景投放目标（复用 `onInsertProjectModel`），再新增 `dragTo`/`drop` 浏览器证据；任何一步失败保留 `review-required`。
3. **发布 OS 证据**：保持本机模拟无网回归；不再追加 clean-machine firewall 证明。
4. **GI**：复核 `gi-crossend-matrix-20260919-r7` 的 on/off 帧和材质/背景输入；背景色彩差异已校准，下一步集中在无 GI 几何/基线照明路径与复杂几何矩阵。只有所有门槛满足才提升状态。
5. **D24–D28、工业、DE26**：沿各自现有报告的缺口矩阵补独立证据；每完成一条，从本文件对应的“下一证据缺口”删除，并同步 `docs/active-task-recovery-ledger.md`。

工作树目前包含大量并行会话的用户改动。只提交或审阅当前范围内的文件；不要用 reset/checkout 清理，也不要把 `test-output` 全量提交。工业工作必须遵守 `docs/specs/industrial-3d-format-work-plan-2026-09-16.md` 和根目录 `AGENTS.md`。

## Skills to use

- `Code`：实现运行包 ABI、同步脚本和验证器，并按现有测试风格回归。
- `handoff`：每次会话结束刷新本文件和 OS 临时交接副本，保持五段结构和引用式记录。
- `e2e-testing`：补 V11 拖放/持久化、发布链和动态运行包的真实端到端证据。
- `design-taste-digitaltwin`：涉及场景/3D/跨端画面变更时执行视觉闭环，不用截图替代功能证据。
- `documentation-and-adrs`：ABI、工业边界和验收状态发生变化时更新规范与决策记录。

## Artifacts

权威入口和证据：

- 总账：`docs/active-task-recovery-ledger.md`
- 八项索引：`test-output/mainline-closure-20260918/closure.json`
- 校验器：`scripts/verify-mainline-closure.mjs`
- GI 收口判定与失败回归：`scripts/lib/giClosureEvidence.mjs`、`scripts/lib/giClosureEvidence.test.mjs`（7 项通过；严格 on/off 完整性、归一化值和 edge F1，缺项不通过）
- D24–D28 后验收卡门禁：`scripts/lib/projectPostAcceptanceEvidence.mjs`、`scripts/lib/projectPostAcceptanceEvidence.test.mjs`（V01–V05 完整性；只有独立证据才允许 passed）
- 工业 S1–S6 汇总门禁：`scripts/lib/industrialStageDeltaEvidence.mjs`、`scripts/lib/industrialStageDeltaEvidence.test.mjs`（只识别 S1–S6，忽略历史 S0 行）；主线索引同时绑定机器矩阵 JSON 的 hash 和 profile 状态
- 剖切 E2E：`test-output/scene-clipping-e2e-20260918-r3/evidence.json`
- 动态运行包审计：`docs/specs/dynamic-scene-runtime-audit-2026-09-18.md`、`test-output/dynamic-scene-runtime-audit-20260918/audit.json`
- 动态 ABI/正式资源：`packages/deep-engine/src/runtimePackage/dynamicSceneRuntime.ts`、`packages/deep-engine/src/runtimePackage/types.ts`、`packages/deep-engine/src/runtimePackage/builder.ts`、`packages/deep-engine-native/src/runtime_package/dynamic_scene.rs`、`packages/deep-engine-native/src/runtime_package/payloads.rs`（v7 resource/entrypoint、Native 解码；未宣称播放支持）
- V11 manifest/审计：`docs/specs/de26-v11-kenney-nature-admission-manifest-2026-09-18.json`、`test-output/de26-v11-nature-review-20260918/geometry-units-thumbnail-audit.json`
- V11 派生件：`test-output/de26-v11-nature-review-20260918/derived/fence_gate-grounded.glb` 及同名 `.json` sidecar；源/派生 SHA 记录在 sidecar。
- V11 派生件复核：`scripts/verify-v11-grounded-derived.mjs`、`test-output/de26-v11-nature-review-20260918/grounded-derived-evidence.json`
- V11 报告：`docs/reports/de26-v11-nature-audit-2026-09-18.md`
- 发布链：`test-output/scene-standalone-executable-20260918/evidence.json`、`pixel-evidence.json`、`test-output/scene-publish-offline-20260918-main/evidence.json`
- 发布 OS 只读预检：`test-output/scene-publish-offline-20260919-os-preflight/evidence.json`（`netsh` 状态/策略均 exit 0；明确不冒充干净机器断网证明）
- GI：`test-output/gi-crossend-matrix-20260919-r14/matrix.json`、`docs/specs/lightmap-single-bounce-2026-09-18.md`
- D24–D28：`docs/specs/deep-engine-mainline-closure-recheck-2026-09-18.md`、`docs/specs/de26-a04-a08-paired-runtime-2026-09-18.md`
- 工业：`docs/specs/industrial-stage-delta-2026-09-18.md`、`docs/specs/industrial-s1-s6-acceptance-matrix-2026-09-18.json`、`docs/reports/industrial-s1-s6-closure-2026-09-18.md`
- DE26 readiness：`test-output/de26-local-assets-readiness-20260918/readiness.json`、`docs/reports/de26-asset-readiness-2026-09-18.md`
- DE26 readiness evidence：`scripts/verify-de26-readiness-evidence.mjs`、`scripts/verify-de26-readiness-evidence.test.mjs`、`test-output/de26-local-assets-readiness-20260918/readiness-evidence.json`（覆盖率/缺口/来源路径；派生统计明确 `authoritative=false`）
- DE26 派生 packet 统计：`test-output/de26-local-assets-readiness-20260918/prepared-statistics.json`（由现有本地 glTF 派生件解码；不提升 RVT 源 stats 状态）
- 资产同步：`scripts/sync-open-asset-packs.mjs`

复现入口：

```powershell
cd D:\Documents\bim\bim-studio
node scripts/verify-mainline-closure.mjs
pnpm exec tsx scripts/verify-scene-clipping-e2e.mts test-output/scene-clipping-e2e-20260918-r2/verified-player.exe test-output/lightmap-gi-rotated-20260918 test-output/scene-clipping-e2e-20260918-r3
pnpm exec tsx scripts/verify-gi-crossend-matrix.mts test-output/gi-crossend-matrix-20260918-r5/verified-player.exe test-output/lightmap-gi-rotated-20260918 test-output/gi-crossend-matrix-20260919-r7
node scripts/sync-open-asset-packs.mjs --concurrency=4
node scripts/verify-publish-os-preflight.mjs
node scripts/verify-v11-grounded-derived.mjs
```
