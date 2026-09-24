# Codex → GLM 交接（2026-09-25）

本文件记录 9 月 24 日用户叫停前的工作区状态，供 GLM 继续开发。**用户最后的“任务停下，我要关机了”已执行；本次只写交接，没有恢复构建、上传或开发。**恢复时先检查现场，不把报告中的阶段性通过当成最终发布通过。

## 用户最新目标与优先级

1. 最高优先级：Deep 编辑最终不依赖 Three；Deep WASM / WebGPU 在**同场景、同相机、同画质、同输入轨迹**下性能和操作响应全面超过 Three WebGL。不能靠降画质或只跑单物体 bench 宣称胜出。
2. 完成三引擎切换、WASM 上层编辑接入、全局底层→页面/交互/发布链测试；客户端本地模式和 SaaS 使用同一套功能。本地为 SQLite + 文件存储、启动时可选择连接服务器；复用现有 `.bimproject` 双向迁移，不重建格式或 IndexedDB 子集。
3. Native、Three WebView、Android 发布要验证真实交付包。Android 本轮不要求物理真机；双 ABI 构建/签名与模拟器交互是当前验收口径。客户端及 Native 首帧不得白闪或中间白、下方黑。
4. README 只做增量、保留已有内容。三个破损工作流图标已替换为仓内静态 SVG；它们不代表 CI 通过。
5. **最后再做**面向最终用户的一键 Docker Compose（PostgreSQL + MinIO），仓库保留 Dockerfile，并补文档与 README。开源清理和许可证决策须先核实，不擅自宣布可公开。
6. `deepmonkey-asset-library` 三分卷由用户手动上传完毕；**不要重启上传器、改卷或重复上传**。开源审计仍要求逐资产再分发许可/署名证据。

## 现状核查（先于本交接写入，禁止重复建设）

1. 搜索源目录、文档和未跟踪文件：`StudioDeepWebGpuBridge`、`StudioDeepWasmBridge`、通用 `AiAssistantPanel`、Tauri `start_local_api`、发布资源准备脚本和相关 E2E 已存在；当前有大量 `??` 新脚本、测试和资源，不能按旧 HEAD 从零开发。
2. 契约层：`packages/contracts/src/scene.ts`、`application.ts`、`project.ts`、`assetLibrary.ts` 已有场景、发布、项目和资产状态合同；不新建平行合同。上层当前消费点见 `apps/web/src/viewer/`、`apps/web/src/views/`、`apps/web/src/adapters/`、`apps/api/src/` 和 `apps/desktop/src-tauri/src/`。
3. 依赖：`apps/web/package.json` 已接 `@bim-studio/deep-engine` 和 Tauri API；`apps/desktop/src-tauri/Cargo.toml` 已使用 Tauri 2；根 `package.json` 已有 Deep、WebGPU、发布与仓库门禁。先复用这些入口。
4. 测试和证据：相关 `*.test.ts(x)`、`apps/web/scripts/engine-switch-integration-e2e.mjs`、`deep-gpu-stage-smoke.mjs`、`test-output/` 和下列报告均已存在。报告是其记录时刻的证据，不等于当前工作树自动全绿。
5. 规格/总账：已核对 `docs/specs/surpass-engines-extreme-optimization-plan-2026-09-21.md`、`docs/specs/deep-web-parity-contract-2026-09-21.md`、`docs/active-task-recovery-ledger.md`、前一份 `docs/handoffs/gpt-handoff-2026-09-24.md`。前一份是 GLM→GPT 的**旧快照**，其中尚称 `.002 starter`；用户后来手动完成上传，以最新用户指令和本文件为准。
6. Git：分支 `dev-studio`、HEAD `5c09e1af`。本轮大量改动未提交；当前 `git diff --stat` 为 259 个 tracked 文件、约 +5599/-2148 行，另有未跟踪文件。GLM 首先运行 `git status --short`、`git diff --check`，逐文件认领；勿批量清理、重置或把旧报告的状态覆盖为当前事实。

## 已有能力与证据（不重建）

| 领域 | 当前可证实的阶段结果 | 证据 / 边界 |
|---|---|---|
| 三引擎切换 | Studio 真实 WebGL→Deep WebGPU→Deep WASM→WebGL、保存/恢复/回退、移动视口与故障回退通过；0 HTTP 5xx、0 非预期错误、0 黑帧；三画布均 728×748 | `docs/reports/engine-switch-integration-2026-09-24.md`；`test-output/engine-switch-integration/report.json` SHA-256 `e008935b6ab4a3db58d20659edcba3f6d58ea2407b0e7ba2abbc7e9657487509`。**仍有 Three 作者输入/拾取/gizmo 权威路径**，切换成功不等于纯 Deep 编辑。 |
| WASM 产品包 | 完整引擎 raw 5,187,736 B，gzip 2,009,743 B，brotli 1,452,694 B；`wasm32` check 和 Web 聚焦测试通过 | 旧约 153 KB 是 `bench-viewer` 切片，不能与正式完整包混淆。 |
| GPU 诊断 | 静态无变形路径移除空 preparation，真实 Chrome 单球烟测连续 12 帧均只提交 1 个 command buffer；4-query 粗 GPU 时间戳可用 | `test-output/deep-gpu-stage-smoke/report.json` / `frame.png`；仅单球诊断，不是 Studio 同画质 A/B 或整帧 present 时间。引擎报告写于该烟测前，故其“真实 submit 计数待测”已被此**局部**证据更新。 |
| Native 首屏 | 最终 base `packages/deep-engine-native/target/release/deep-engine-native.exe`：20,681,216 B，SHA-256 `acbb870dd676d4248802621aff522fc17e3978185e146e547d0833fc8f37c1d5`。默认/自定义追加包 10ms 录帧，首个屏幕可见帧已为完整场景，无白黑分裂 | `test-output/native-publication-first-frame-dwm-stage-final-20260924/transition-{default,custom}-onscreen/`。这是 Native 播放器首屏证据，不代表 Tauri 安装器同步完成。 |
| 本地工作台 | Tauri 包内完整 API + SQLite + 文件对象库，动态回环端口；真实 GUI 进入二维/资源/三维/发布、WebSocket 101，导航未见 502；本地/SaaS `.bimproject` 双向迁移已有真实 round trip | `docs/reports/global-integration-gate-2026-09-24.md`、`tauri-local-api-integration-2026-09-24.md`、`local-saas-transfer-publish-parity-2026-09-24.md`。旧 IndexedDB 子集仅兼容测试，不是产品路径。 |
| 2D AI | 二维已复用通用 `AiAssistantPanel`，旧独立 Draft 入口删除；diff 确认、会话 scope、viewer 权限测试 36/36；真实 Tauri 页面能打开 | `docs/reports/deep2d-ai-assistant-unification-2026-09-24.md`、`test-output/global-integration-gate-20260924/tauri-final-2d-ai-open.json`。 |
| Android | 双 ABI 模板/发布 APK 注入、zipalign、v2/v3 验签；x86_64 模拟器安装、冷启、渲染、触摸通过 | `docs/reports/android-publication-integration-2026-09-24.md`；不要求真机，仍须与**最终本地安装版**联测发布入口。 |
| README 图标 | 中英文各三个坏图替换成仓内静态 SVG，深/浅色预览及本地路径检查通过 | `docs/reports/readme-content-audit-2026-09-24.md`；不表示远端 Actions 绿。工业预制体 tab 裁切用户已确认修好，勿反复验。 |

## 本轮待办与明确阻断（按执行顺序）

1. **Deep 纯编辑与公平性能门禁（P0）**：先画出 Three 仍掌控输入/拾取/gizmo/相机/场景作者态的调用图，按现有桥/合同逐项替换，不复制实现。当前顺序烟测 rAF p95：WebGL 7.1ms、WebGPU 13.7ms、WASM 7.1ms；pointer→backend submit p95：1.5/8.0/23.4ms。三者未固定相机；截图亮度 WebGL 40.62、WebGPU 93.98、WASM 39.74，不能宣称同画质或“全面超过”。建立固定场景/相机/材质/光照/分辨率/输入轨迹的配对 runner，像素或 SSIM 守卫 + input→present P50/P95/P99 + CPU/GPU/内存指标；以实测瓶颈优化无损 pass/队列/更新路径。`gate-render-engine-comparison.mjs` 只比较 Three WebGL 与 Three WebGPU，**不能**充当 Deep 胜出证据。
2. **Tauri/发布资源闭包（P0）**：当前桌面 EXE `apps/desktop/src-tauri/target/release/bim-studio-desktop.exe` 是 2026-09-24 17:41 的 59,762,688 B，SHA-256 `428d2f304306ad64acd5127ab0b4f67e2589d70afc3bbdce34c993fe1ee551b8`；最终 Native base 是 17:50 才生成。磁盘 NSIS 文件是 15:38、441,476,260 B，早于两者；MSI 目录未见文件。旧 `local-publication-runtime-smoke` 仍用 Native SHA `3145...`。因此需在恢复后用最终 Native base 重做 `prepare-local-api-runtime`/资源清单、Tauri release、真实 50ms 首帧录制两轮、NSIS/MSI、`verify:bundle`、安装/启动/2D/3D/发布链与包 hash；不能把旧安装包标记最终完成。主 WebView 和 HTML 暗底源码已有修复，**最终二进制视觉验收未闭合**。
3. **全局回归（P0）**：按底层合同→API→Web/编辑器→真实 Tauri/Native/Android 发布入口串联；重点测试 Three/WebGPU/WASM 切换后场景编辑、交互、保存与发布；本地 SQLite/文件与 SaaS PostgreSQL/MinIO 功能及 `.bimproject` 同项目往返。API/Web 全量曾在受限并发下分别 1558/4352 tests 通过，但工作树后续又有改动，须在最终冻结后重跑。真实页面旧证据不能替代新安装版。
4. **仓库治理/开源（P0；外发 NO-GO）**：本次现场运行 `pnpm gate:repository`，其 5 个测试通过，但内容检查失败：README 缺 `MIT License + Ethical Restrictions` 和 `source-available`。这与先前报告的“门禁通过”是不同时间快照。根 `package.json` 写 MIT，根 `LICENSE` 引用附加限制，中文许可证/LICENSING/AGENTS/元数据仍混合口径；标准 MIT 与许可中的排除限制不能同时声称。需项目所有者决定**标准 MIT**或**保留限制的 source-available**，再统一法律文本、包元数据、README 和门禁；不要为单纯过测试而回填矛盾文案。另有素材包逐资产许可/署名、高危依赖、远端 CI、全历史 secrets 扫描等公开阻断。详见 `docs/reports/open-source-readiness-audit-2026-09-24.md`；其早期工作树数量/门禁结果已过时。
5. **最后的 Docker 交付**：确认现有 Dockerfile、Compose/部署配置再补缺口；交付 PostgreSQL + MinIO 的一键 Compose，提供 `.env.example`、持久卷/初始化/健康检查/升级与数据保护说明，中英文 README 只增量加入口。必须在核心能力和全局测试收尾之后做。

## 接手注意

- 先读 `bim-studio/AGENTS.md` 与上列 specs/报告；遵守六步现状核查、改动归属和证据分级。`test-output/` 是本机证据，未跟踪源码与资源不能随手删除。
- 不重启素材上传；不把旧 NSIS 或旧 Native v4 哈希混作最终产物；不把 GPU 单球 0.2ms 粗段计时写成整帧或同画质优势。
- 无需 Android 真机。Three WebView 安装版曾显式 503（资源未随包）而后在**旧桌面 base** 上通过 standalone EXE 实测；最终 installer 必须复核资源包含与同一 base。
- 先交付真实通过/失败的门禁报告，再决定提交与公开；当前没有本轮新 commit/push。任何百分比只能对应明确分母和证据，不从“切换成功”推导“引擎完成”。
