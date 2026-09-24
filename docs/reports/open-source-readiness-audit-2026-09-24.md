# Open-source readiness audit — 2026-09-24

审计对象：`fatasia/bim-studio`，本地分支 `dev-studio`，快照基线 `5c09e1af`。交接记录载明用户希望 GitHub 显示 MIT，最新“作者的话”又保留对特定企业的排除条款；这两项目标不能由同一份标准 MIT 许可证同时满足。现有额外限制使 GitHub 无法将其识别为 MIT。以下同时列出标准 MIT 开源路线与保留限制的源码可用路线，不替用户改动授权选择。报告只记录事实与整改项，不修改 `AGENTS.md`、许可证政策文件或产品代码。

## 结论

**当前结论：NO-GO，不应把仓库切为 public，也不应把现有 Asset Library Release 暴露给公众。**

主要原因不是功能完成度，而是五个发布阻断：

1. 根 `package.json` 已声明 `MIT`，但根 `LICENSE` 在标准 MIT 文本后追加了构成授权条件的伦理限制；GitHub API 当前返回 `licenseInfo: null`，并未识别为 MIT。
2. 默认分支 `main` 比 `dev-studio` 落后 994 个提交；GitHub 最近的 Repository governance、Deep Engine、Studio 三套工作流全部失败，本地工作树也有 134 条状态记录。
3. 已上传的 4.38 GB 素材 Release 缺少可执行的逐资产再分发许可与署名证据，包内还存在 `review-required` 与 `published` 的直接矛盾。
4. `pnpm audit --prod` 报告 28 个漏洞，其中 15 个 High；GitHub Dependabot alerts、secret scanning、code scanning 均未启用。
5. 尚未完成可信的全历史秘密扫描。简化启发式扫描没有命中常见令牌，但它不能替代 Gitleaks/TruffleHog 对所有 refs、tags、release artifacts 和大二进制的检查。

## 现状核查（强制六步）

### 1. Git history、status 与未跟踪文件

- 当前 HEAD：`5c09e1af chore(license): 根 package.json license 字段切 MIT`。
- 默认分支：GitHub `main`；`origin/main...origin/dev-studio = 0 / 994`，即 `dev-studio` 单向领先 994 个提交。
- 工作树：120 个已修改、5 个已删除、9 个未跟踪入口，共 134 条状态记录。未跟踪目录展开后还包含多个 benchmark 脚本与 lockfile。
- 仓库共 7,336 个 tracked files、1,021 个可达提交；pack 约 100.94 MiB。
- 本机 `.env`、`.env.previous`、`.env.before-*`、`auto.key`、`auto.crt`、日志、`test-output/`、`artifacts/`、`node_modules/` 均存在但被忽略，未被当前索引跟踪。历史敏感文件名检查只发现 `.env.example` 与语义上名为 token/secret 的源码或测试，没有发现真实 `.env`、私钥或证书路径曾被跟踪。

### 2. 合同与元数据层

本任务的合同层是许可证、包元数据、发布清单与治理断言：

- 根 `package.json`：`license: MIT`、`private: true`、版本 `0.1.0`。
- 根 `LICENSE`：前 25 行是 MIT，26–30 行把 `LICENSE-RESTRICTIONS.md` 声明为许可的组成部分。
- `LICENSE.zh-CN.md`：仍是 `Deep Monkey Community Source License 1.0` / `LicenseRef-Deep-Monkey-Community-1.0`。
- `LICENSING.md`：明确写成 `MIT with Ethical Restrictions`、`DMS-MIT-ER-1.0`、`not OSI open source`。
- `apps/battery-native-runtime/Cargo.toml`：仍声明旧 `LicenseRef-Deep-Monkey-Community-1.0`。
- 其他 Native/WASM/Android/Tauri crate 使用 `license-file` 指向根 `LICENSE`，因此也继承当前额外限制，而不是标准 MIT。
- 治理脚本 `scripts/check-repository-governance.mjs` 的 `LICENSE_ID` 虽已改成 `MIT`，却仍强制根 LICENSE 包含 `ETHICAL RESTRICTIONS`，并要求 README 保持 `source-available`；这会制造“package metadata 是 MIT、法律文本不是 MIT、门禁仍绿”的假一致性。

### 3. 依赖与分发闭包

- JavaScript：根 `pnpm-lock.yaml`，另有隔离 benchmark / physics harness 的 npm lockfile。
- Rust：Native、WASM、Android、Tauri、电池运行时、physics validate 和 benchmark 均有独立 `Cargo.lock`。
- .NET：Revit worker 有两个 `.csproj`。
- 当前 `pnpm audit:licenses` 只覆盖 pnpm 生产依赖；没有统一覆盖全部 Cargo lockfile、.NET NuGet、vendored WASM、模型、字体与 Release 素材包。
- `THIRD_PARTY_NOTICES.md` 已存在并记录多类依赖，但 Linux CI 仍发现 `@img/sharp-libvips-linux-x64@1.3.2` 的 LGPL-3.0-or-later notice 缺失，说明本地 Windows 通过不代表跨平台分发闭包完整。

### 4. 消费方与发布路径

- 根 `verify:release` 会串联治理、许可证、类型检查、测试、构建和产品门禁，但 GitHub 工作流没有运行这一完整发布门禁。
- GitHub 只有 `repository-governance.yml`、`studio.yml`、`deep-engine.yml`；没有 Android、WASM、Windows installer、Native release、SBOM、签名与发布工件工作流。
- `SECURITY.md` 要求优先使用 GitHub private vulnerability reporting，但 API 返回 404；该能力当前不可用。
- `scripts/check-repository-governance.mjs` 是当前许可证、敏感路径和大文件策略的主要消费方；其跨平台大文件哈希口径目前不稳定。
- Asset Library Release `asset-library-v1` 指向陈旧默认分支 `main`；Release body 称“v1.1”，tag 和 pack manifest 却是 `v1` / `1.0.0`。

### 5. 测试与证据

本轮只运行只读检查，结果如下：

| 检查 | 结果 | 说明 |
|---|---|---|
| `pnpm gate:repository`（本地） | PASS | 5 个测试通过，当前工作树门禁通过 |
| `pnpm audit:licenses`（本地 Windows） | PASS | 529 个生产 package versions、1 个 override、3 个 reciprocal packages |
| `pnpm docs:wiki:check` | PASS | 32 篇文章一致 |
| `pnpm quality:public-brand` | PASS | 品牌隔离与图标检查通过 |
| `pnpm audit --prod --audit-level=high` | **FAIL** | 28 漏洞：2 Low、11 Moderate、15 High |
| GitHub Repository governance | **FAIL** | 大文件例外哈希漂移；Linux LGPL notice 缺失 |
| GitHub Deep Engine | **FAIL** | isolation 依赖污染、Windows 缺 `shadow_map.rs`、Linux cargo test 失败 |
| GitHub Studio | **FAIL** | Web 缺 `dashboardTemplateCatalog`；API 缺 JT fixtures、模型清单漂移及断言失败 |
| 全历史令牌启发式 | 未发现明确命中 | AWS/GitHub/OpenAI/Slack/Google key、private-key header、JWT 常见格式均为 0；不是完整秘密扫描 |
| Asset Library archive inspection | **FAIL** | 缺实际许可证文件与逐资产来源/许可字段，状态合同自相矛盾 |

远端 Repository governance 的大文件失败可以复现到口径差异：CSV 的 Git blob 是 LF，SHA-256 为 `084e3c...`，Windows 工作树是 CRLF，SHA-256 为配置记录的 `632d30...`。当前门禁对工作树原始字节做 SHA-256，因此本地通过、Linux checkout 失败。

### 6. 规格、交接与总账

- 已读取 `docs/active-task-recovery-ledger.md`、`docs/handoffs/gpt-handoff-2026-09-24.md`、`docs/OPEN_SOURCE_READINESS.md`、`docs/open-source-release-checklist.md` 及相关 specs。
- `docs/OPEN_SOURCE_READINESS.md` 与公开清单仍以 `MIT with Ethical Restrictions/source-available` 为准；该口径与现有额外限制一致，但与根 `package.json` 的 `MIT` 声明不一致。
- 仓库级 `AGENTS.md` 仍把 `LicenseRef-Deep-Monkey-Community-1.0`、`source-available` 和非 OSI 声明规定为唯一政策，与当前许可证文件、根 `package.json` 和提交说明冲突。本报告只指出冲突，不修改该文件。

## P0：公开前必须完成

### P0-01 统一许可证目标与元数据

**事实**

- `LICENSE` 的额外条件意味着整个法律文本不是 SPDX `MIT`。
- GitHub 当前仓库查询结果是 `licenseInfo: null`，不是 MIT。
- `package.json: MIT` 与实际授权文本不一致。
- README、英文 README、中文许可证、LICENSING、CONTRIBUTING、PR template、应用内文档、portable package、Unity license copy、Cargo metadata 和治理断言互相冲突。

**动作**

1. 若目标是 OSI 标准 MIT，根 `LICENSE` 必须只保留规范 MIT 文本，不能把用途限制作为授权条件或通过引用并入许可。若保留对特定企业的排除，则应如实使用自定义许可证标识与 `source-available` 表述，不能在包元数据中声称标准 MIT。
2. 同批更新 `LICENSE.zh-CN.md`、`LICENSING.md`、`README*`、`CONTRIBUTING.md`、PR template、应用内社区文档、package/Cargo metadata、Unity 镜像、打包 notice 与治理测试。
3. 若仍希望表达伦理立场，可作为不改变 MIT 权利的价值声明或 Code of Conduct，不能继续写成 `integral part of the license`。法律措辞应由项目所有者最终确认。
4. 修改门禁，使其验证根 LICENSE 与 SPDX MIT 的规范文本/哈希，而不是只查找 `MIT License` 字样。
5. 公开前重新查询 GitHub API，必须得到 `licenseInfo.spdxId == MIT`。

### P0-02 建立唯一、干净、可发布的默认分支

**事实**

- 默认 `main` 落后 994 个提交；当前 Asset Release 仍指向 `main`。
- 本地工作树有 134 条状态记录，包含跨 WASM、Native、AI、UI 的大量并行改动。
- 最近三套 GitHub 工作流全部失败。

**动作**

1. 按功能切片审查并提交当前变更，排除实验输出与本地脚本；不得把当前脏工作树直接作为公开快照。
2. 用 PR 或明确发布合并把选定 revision 落到 `main`；发布前在 clean clone、Linux 和 Windows 上跑完整门禁。
3. 修复并重跑远端失败：大文件哈希、Linux LGPL notice、Deep isolation、Native 缺文件、Web 缺模块、API 缺 fixtures/模型清单。
4. 所有 required checks 绿后再打 `v0.1.0`（或用户选定版本）签名 tag；Asset Library tag 不替代软件发行 tag。

### P0-03 隔离或重建当前 Asset Library Release

三卷本身上传完整，GitHub digest 与本地 SHA-256 一致；问题在授权与发布合同，不在传输。

**实测证据**

- Release：`asset-library-v1`，3 个 volume 全部 `uploaded`，总计约 4.38 GB。
- `pack.manifest.json`：`publicationStatus: published`、`license: SEE LICENSING.md`、4,653 files。
- 压缩包内没有 `LICENSING.md`、`LICENSE`、`NOTICE`、`README`、provenance 或 attribution 文件。
- `audit.json` 有 1,551 个模型条目，但 1,551/1,551 都没有 `license`、`licenseId`、`source/sourceUrl`、`author`、`attribution` 或 `redistributable` 字段。
- `catalog.json` 的 1,550 个模型同样没有上述字段。
- `audit.json.library.defaultPublicationStatus` 是 `review-required`，并把 `asset-level-provenance`、`publication-license-status`、`brand-and-metadata-review` 列为 required metadata；总 manifest 却标记为 `published`。
- Release body 写 v1.1，tag/manifest 写 v1/1.0.0，且 target commitish 是落后 994 提交的 `main`。

**动作**

1. 仓库公开前把该 Release 设为不可公开的草稿/临时隔离，或用审核后的同版本替换；不能因为分卷摘要正确就视为可再分发。
2. 每个资产必须绑定来源 URL、作者、原始许可证、修改说明、署名、再分发结论和文件 SHA-256；未知/禁止再分发项从公开包剔除。
3. 包内必须实际携带项目许可证、第三方 notices、逐资产 provenance 和机器可读清单；`SEE ...` 引用必须能在包内解析。
4. 审计器必须 fail-closed：缺任一 required metadata 时不得输出 `publicationStatus: published`。
5. 为三卷单独发布 `SHA256SUMS`、完整文件清单、包版本、构建 revision 和可复现构建命令。

### P0-04 修复 High 级依赖漏洞并增加持续门禁

`pnpm audit --prod` 当前 High 级命中：

- `xlsx`：GHSA-4r6h-8v6p-xvw6、GHSA-5pgg-2g8v-p4x9；
- `adm-zip`：GHSA-xcpc-8h2w-3j85、GHSA-7q85-xj36-vmfc；
- `@fastify/static`：GHSA-83w8-p2f5-377r；
- `fast-uri`：GHSA-5jgf-p345-68v8、GHSA-f65p-4m7j-42xc、GHSA-fph4-wmhf-6fwf、GHSA-jqff-g426-hqxp；
- `sharp`：GHSA-rgj7-g3m4-5g8c；
- `nodemailer`：GHSA-2x7j-588g-ccc2。

先确认可达性，再升级或替换；涉及文件导入、ZIP、静态路由与 SSRF 的命中直接面向不可信输入，不能只登记豁免。CI 应对生产依赖执行漏洞门禁，并给每个暂缓项设置 owner、到期日、可达性证据和补偿控制。

### P0-05 完成全历史、Release 与大二进制秘密/隐私扫描

**已有好迹象**

- 当前 tracked tree 与 1,021 个提交的常见令牌启发式没有明确命中。
- `.env`、私钥、证书、日志和测试输出当前均被忽略。
- 没有 tracked editor/OS junk、HAR、trace 或登录截图。

**仍缺**

- 本机没有 Gitleaks、TruffleHog、Semgrep；当前检查没有解包 ONNX、tgz、7z、GLB、图片元数据或 release assets。
- GitHub secret scanning 和 code scanning 均关闭。

**动作**

1. 在 disposable mirror 对 `--all` refs/tags 运行至少一种成熟 secret scanner，并人工复核命中。
2. 扫描 Release assets、Actions logs、LFS（如启用）、压缩包和模型 metadata；证据只保留脱敏摘要。
3. 若发现真实秘密，先撤销/轮换，再按对象 ID 评估 `git filter-repo`；无秘密或法律问题时不要为“好看”重写历史。
4. 仓库公开后立即启用 secret scanning/push protection、CodeQL/code scanning、Dependabot alerts 与 private vulnerability reporting。

### P0-06 公开切换时启用仓库保护

当前仓库是 private，GitHub 免费计划 API 对 branch protection/rulesets 返回 403；这不代表已经保护。切 public 后应在同一维护窗口立即：

- 保护 `main`，禁止 force push / delete；
- 要求 PR review、对话解决、线性历史或明确 merge 策略；
- 把治理、Studio、Deep Engine、WASM、Native/Android release 检查设为 required；
- 收紧 Actions token 权限，发布 job 使用 environment approval；
- 启用 private vulnerability reporting，并验证 SECURITY.md 链接返回可用页面。

## P1：首个公开版本前完成

### P1-01 修复本地通过、Linux 失败的治理门禁

- 大 CSV 被 Git 作为 text 规范化为 LF，但例外哈希记录的是 Windows CRLF 工作树字节。门禁应对 Git blob/规范化内容校验，或把确实需逐字节固定的资产明确标成 binary；同一 revision 在所有平台必须得到同一摘要。
- 许可证审计要固定目标平台集合并合并 inventory，不能只审当前 OS 安装到的 optional packages。
- Linux CI 缺 `@img/sharp-libvips-linux-x64` 的 LGPL notice，必须补 notice/source offer 并加入跨平台测试。

### P1-02 清理不可移植路径与调试制品

当前 tracked code 中存在明确机器绑定：

- `apps/web/public/dev/engine-glue.js` 硬编码 `/@fs/D:/Documents/bim/.../test-output/...`；
- `scripts/p03-04-device-matrix/harness/Cargo.toml` 与多处 `#[path]` 硬编码 `D:/Documents/bim/...`；
- `scripts/run-mega-sync.sh` 首行直接 `cd D:/Documents/bim/bim-studio`；
- `packages/deep-engine/fixtures/benchmark-assets/manifests-v1.json` 含本机绝对路径。

应改为仓库相对路径、CLI 参数或 fixture root。报告/历史证据里的绝对路径可以保留或在公开分支排除，但运行入口不能依赖个人目录。

`r10-compat-check/dimforge-rapier3d-compat-0.20.0.tgz` 是 3.16 MiB 可再获取的调试包；提交说明还声称该目录“不入库”，与事实矛盾。用普通删除提交移除当前树即可，除非后续发现法律/秘密问题，不必仅为体积重写历史。

### P1-03 审查所有未跟踪脚本，禁止整批提交

- `scripts/build-asset-pack.mjs` 当前 `node --check` 直接 SyntaxError（`rm stage if exists`），且许可证逻辑只写笼统 `SEE LICENSE`，没有逐资产 fail-closed。
- `scripts/upload-asset-volumes.sh` 硬编码个人盘符、仓库、测试日志位置和 40 次重试；它是一次性运维脚本，不应未经改造进入公共仓库。
- `apps/web/scripts/prefab-overflow-diag.mjs`、WASM E2E、新测试和 Babylon benchmark 必须逐文件审查来源、必要性、锁文件与 CI 消费方后再提交。

### P1-04 完成跨生态依赖、模型与资产 NOTICE

- 为全部 Cargo.lock 运行 `cargo-deny` / `cargo-audit` 或等价固定门禁，记录许可证选择与 advisory 豁免。
- 为两个 Revit `.csproj` 生成 NuGet license/vulnerability inventory。
- 审计 vendored Basis WASM、ONNX 模型、BatteryLife/TEMPEST CSV、YOLOX 权重、字体、HDRI/纹理/GLB 的来源、修改和再分发权。
- 当前三个 >5 MiB tracked 文件有哈希例外，但“有 hash”不等于“有再分发权”。特别是 34.36 MiB / 20.52 MiB ONNX 与 9.57 MiB CSV，应把来源和许可落到邻接 manifest，并由 CI 校验。
- 生成 SPDX 或 CycloneDX SBOM，随每个软件发行工件发布；模型/素材包使用单独资产 BOM。

### P1-05 增加真正的发布 CI

现有 Actions 未覆盖：

- WASM `wasm32-unknown-unknown` build、wasm-bindgen/wasm-opt、浏览器 E2E；
- Android Rust/Gradle assemble、APK/AAB、签名占位与安装 smoke；
- Windows Native / Tauri installer / portable package clean build；
- 发布工件 license/notices/SBOM/checksum/provenance；
- Linux/Windows clean-clone quickstart；
- `pnpm verify:release` 的完整闭环。

所有第三方 Actions 目前使用可移动 major tags（如 `actions/checkout@v4`），公开项目建议固定到完整 commit SHA，并由 Dependabot 管理更新。

### P1-06 重写活跃开源文档，而不是全局替换历史

必须更新的活跃入口包括：

- `README.md`、`README.en.md`；
- `LICENSE.zh-CN.md`、`LICENSING.md`；
- `CONTRIBUTING.md`、`.github/PULL_REQUEST_TEMPLATE.md`；
- `docs/OPEN_SOURCE_READINESS.md`、`docs/open-source-release-checklist.md`；
- `apps/web/src/docs/community.md` 等应用内文档；
- portable/native package 的 README 与 license assertions；
- `AGENTS.md` 的旧许可证规则（需用户授权后单独处理，本报告未改）。

README 快速启动明确暴露 `admin/admin`。生产配置已有 `apps/api/src/productionConfig.ts` 的弱口令阻断，这是正面基础；公开文档仍应把默认账号标为仅限 loopback 开发，并给首次部署一个强制随机密码/轮换的最短路径。

### P1-07 筛选公共文档与内部作业记录

- `docs/specs/` 有 349 个文件（约 4.11 MiB），`docs/reports/` 有 62 个文件；大量 GLM/Codex/GPT handoff、个人磁盘路径、会话恢复台账对外维护价值有限。
- 应建立 public-doc allowlist：保留架构、ADR、格式合同、可复现验收；把内部会话交接、机器专属取证和过时任务恢复文档移出发布分支或压缩成一份维护者历史。
- 不要为了“去 AI 痕迹”改写仍有技术证据价值的设计决策；删除或归档的标准应是是否服务外部用户/贡献者、是否泄露本机/内部流程，而不是作者工具名称。

## P2：公开后尽快补齐

- 补 GitHub description、homepage、topics；当前三个字段均为空。
- 增加 `CODEOWNERS`，为许可证、security、workflows、runtime contracts 指定 reviewer。
- 设置自动删已合并分支、Web commit signoff 或 DCO/CLA 策略；当前 `delete_branch_on_merge=false`、`web_commit_signoff_required=false`。
- 把巨大 `Unreleased` CHANGELOG 冻结成首个版本，增加 upgrade / rollback / known limitations。
- 发布签名 tag、checksums、SBOM、SLSA provenance；当前没有软件版本 tag，只有素材 Release。
- 可选补 `AUTHORS`、`CITATION.cff`、funding；它们不是公开阻断。
- 为 issue labels、triage SLA、roadmap 状态与 support 边界建立维护流程；Issue/PR 模板本身已存在且结构可用。

## 不应盲改的历史与兼容 fixture

| 路径/类型 | 处理方式 | 原因 |
|---|---|---|
| `packages/deep-engine-native/tests/fixtures/asset-directory-v1/**` 中的旧 `LicenseRef`、license blob 和 hash | 保留为显式 `legacy-v1` golden；新增 MIT 当前 fixture | 它验证历史包解析与哈希，直接替换会破坏兼容证据 |
| 解析器接受旧 `LicenseRef-Deep-Monkey-*` 的分支 | 保留只读兼容，禁止新包继续生成 | 旧用户工件仍需读取；生成侧与读取侧责任不同 |
| `CHANGELOG.md` 已发布历史、旧 specs/reports/handoffs | 不做全局字符串替换；添加 superseded 标记或从 public allowlist 排除 | 改写历史会制造错误审计轨迹 |
| `THIRD_PARTY_NOTICES.md` 中第三方 MIT/Apache/MPL/LGPL/GPL 等标识 | 逐项保留 | 项目切 MIT 不改变第三方许可证 |
| 测试中的 `admin/admin` fixture | 不当作秘密泄露；仅与生产默认行为分开审查 | 公开测试凭据是固定 fixture，不是生产 credential |
| docs gold screenshots 与品牌图标 | 有来源、哈希和消费测试时保留 | 生成文件不等于垃圾文件；这些属于离线文档与品牌回归资产 |

## 建议执行顺序

1. 冻结 public release revision；先不切 public。
2. 处理标准 MIT 一致性与 Asset Library Release 隔离。
3. 修复 15 个 High 漏洞、远端 CI 红项和跨平台许可证 notice。
4. 清理绝对路径、调试 tgz、无效/一次性脚本；按 public-doc allowlist 收敛内部文档。
5. 在 clean clone 上完成 Windows + Linux + WASM + Native + Android 发布矩阵。
6. 对所有 refs、压缩包、模型和 Release artifacts 做秘密与再分发扫描。
7. 合并到 `main`，生成签名软件 tag、SBOM、checksums 与 release notes。
8. 切 public，并立即启用 branch protection、required checks、secret/code scanning、Dependabot alerts 和 private vulnerability reporting。
9. 通过 GitHub API 复核：`visibility=PUBLIC`、`licenseInfo.spdxId=MIT`、rulesets 生效、security features 开启、全部 required checks 绿色。

## 证据路径与外部状态

- 许可证：`LICENSE`、`LICENSE-RESTRICTIONS.md`、`LICENSE.zh-CN.md`、`LICENSING.md`。
- 治理：`scripts/check-repository-governance.mjs`、`config/repository-large-file-exceptions.json`、`.github/workflows/*.yml`。
- 依赖：`pnpm-lock.yaml`、各 `Cargo.lock`、Revit `.csproj`、`THIRD_PARTY_NOTICES.md`。
- 公共文档：`README*`、`CONTRIBUTING.md`、`SECURITY.md`、`GOVERNANCE.md`、`CHANGELOG.md`、`docs/OPEN_SOURCE_READINESS.md`、`docs/open-source-release-checklist.md`。
- Release：`https://github.com/fatasia/bim-studio/releases/tag/asset-library-v1`；三卷 GitHub digest 已上传完整。
- 本地素材包只读检查源：`D:/Documents/bim/asset-pack/out/deepmonkey-asset-library-v1.7z.001`。
- GitHub 状态（审计时）：private；licenseInfo null；main 无保护能力；Dependabot alerts / secret scanning / code scanning 未启用；最近 Actions 全红。

本报告的启发式秘密扫描和许可证清单不是法律意见，也不是最终安全认证；它给出的是公开前可以逐项关闭的工程门禁。
