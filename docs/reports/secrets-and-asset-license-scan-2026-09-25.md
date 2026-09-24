# Secrets 全历史扫描与素材再分发许可核查 — 2026-09-25

针对 `docs/reports/open-source-readiness-audit-2026-09-24.md` 两项"公开阻断"残留的当前时点核查。
只读扫描:未修改任何源码、历史与资产;本报告为唯一新增文件。

---

## 一、方法与工具版本

| 项 | 值 |
|---|---|
| 扫描器 | gitleaks v8.30.1,`windows_x64.zip`,官方 GitHub release 下载 |
| 压缩包 SHA-256 | `d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e`(与官方 `gitleaks_8.30.1_checksums.txt` 逐字一致) |
| 使用位置 | `%TEMP%\gitleaks-scan\`(未入仓) |
| 历史扫描命令 | `gitleaks git --log-opts="--all" --redact --report-format json`(默认规则集,max-archive-depth=0) |
| 工作树扫描命令 | `gitleaks dir --redact --max-target-megabytes=1 --report-format json` |
| 分级辅助 | 对每条命中回读实际文件内容逐条定性;报告文件全程 `--redact` 生成 |

**范围**

- 历史:HEAD `86e37b89`,分支 `dev-studio`、`main`、`origin/dev-studio`、`origin/main`;`git rev-list --all --count` = 1,027,`origin/main` 为 `origin/dev-studio` 祖先(0 独有提交),gitleaks 遍历 1,026 个提交、约 74.77 MB patch 文本(与 rev-list 的 1 差值为无补丁提交,不影响覆盖)。**本地是 origin 的超集,本次扫描覆盖远端全部可达历史。**
- 工作树:tracked 内容 + 未跟踪文件 + 被忽略文件(`.gitignore` 生效,`node_modules`/`target` 等被跳过;>1 MB 二进制跳过)。
- 不可达对象:`git fsck --unreachable --no-reflogs` 为空——ODB 内不存在 ref 之外的悬挂敏感对象,扫描面即全部可恢复内容。

**方法局限(如实声明)**

1. 工作树扫描对 >1 MB 文件跳过(data/ 14 GB、packages/ 118 GB 模型二进制不可行);模型二进制内嵌元数据未解包扫描。
2. GitHub Release 三卷素材包(约 4.38 GB,`asset-library-v1`)未扫描——与 09-24 审计同口径,仍属 P0-05 未关闭部分。
3. gitleaks 规则面向凭据模式;中文客户人名/项目名(隐私轴)不属其检测域,隐私轴另用 git 考古单独核查(见 §三.4)。

---

## 二、任务 1:全历史 secrets 扫描结果

### 2.1 总量与分级

| 扫描面 | 命中 | 真实凭据(阻断) | 疑似需人工复核 | 豁免/误报 |
|---|---:|---:|---:|---:|
| 全历史(1,026 提交,--all) | 31 | **0** | **0** | 31 |
| 工作树 tracked 内容 | 31 | 0 | 0 | 31(与历史命中同源同集) |
| 工作树未跟踪未忽略(63 文件) | 0 | — | — | — |
| 工作树被忽略本地产物 | 3,441 | 0(入仓口径) | 2(见下) | 3,439 |

**结论:凭据轴 0 阻断发现。** 31 条 tracked 命中全部定性:

- **29 × generic-api-key**:`packages/deep-engine-native/tests/fixtures/deep_shader_package_*.json`、`runtime-package-shader-v2.json`、`tests/unified_fixed_step_replay.rs`——shader 包确定性 SHA-256 缓存键(如 `deep_shader_package_v1.json:70` 的 `423c1d1c…` 是夹具内容的哈希)与 `cmd-*` 脚本键。属测试夹具固定值,非凭据。
- **2 × generic-api-key**:`apps/api/src/productionConfig.test.ts:21,33`——`BIM_STUDIO_SESSION_SECRET: "0123456789abcdef…"` 序列占位符,该测试本身在验证"拒绝弱占位符"逻辑。
- **1 × square-access-token**:`docs/active-task-recovery-ledger.md:1075`(历史提交 bf59ef45 的 :171)——Tauri MSI 安装包 **SHA-256 校验和**恰好以 `EAAA` 开头,64 位纯十六进制触发 Square 令牌规则,确认为误报(真实 Square 令牌为含大小写与 `-_` 的 base64)。可用 fingerprint `bf59ef45…:docs/active-task-recovery-ledger.md:square-access-token:171` 加入 `.gitleaksignore` 消噪(未执行,属修改)。

### 2.2 本地未入库文件中的真实密钥(仅记录,不入仓)

`auto.key`、`https/private.key`(真实本地 TLS 私钥)与 `.env`/`.env.previous`/`.env.before-service-account-rotation` 存在于本机且均被 `.gitignore` 覆盖(`.gitignore:19 https/*` 等);`git log --all --full-history -- <路径>` 确认**从未被任何提交跟踪**。`apps/battery-native-runtime/target/**.rmeta`(pem_rfc7468 crate 编译产物)为构建缓存。`test-output/**/chrome-profile*/…/shared_proto_db` 的 100 条 gcp-api-key 命中来自 Chrome 会话协议库日志,误报。这些不会随仓库公开,但公开前应继续保证不误 `git add -f`。

### 2.3 已知豁免核对(按任务口径)

- 测试夹具 `admin/admin`:`.env.example` 的 `BIM_STUDIO_ADMIN_PASSWORD=admin` 为文档化开发默认值,README P1-06 已有整改建议——非泄露。
- `.env.example` 全部为空值/占位符(`AI_API_KEY=` 空、`replace-with-a-long-random-secret`),无误填真实值。

### 2.4 隐私轴(总账 09-24"隐私清理"项的现状核查)

总账 2026-09-24 记载:工作树客户串清零(c445c395)、"git 历史含敏感串且 4 提交已在 origin/dev-studio——收尾执行 filter-repo replace-text+强推"。本次核查证实:

- **filter-repo 未执行**:`.git/filter-repo/` 元数据不存在;`origin/dev-studio` tip 仍为审计基线 `5c09e1af`(哈希未变,即该谱系未被重写强推);`c445c395` 对象已不存在(工作树清理改以其他提交/脱敏提交落地)。
- **实际落地的决定记录在提交 `e9c34aca`(2026-09-23,已在 origin/dev-studio)**:"客户人名/项目名/路径全量脱敏……**历史不重写,开源发布走新仓干净初始提交**"。
- **敏感串仍可从可达历史提取**:`docs/GLM-接手会话交接-2026-09-17.md`(95 行,6 处含客户/项目名/个人路径样式内容)与 `docs/specs/industrial-format-plan02-build-trial-2026-09-17.md`(287 行)虽已在当前树删除,但 `e9c34aca^` 即可原样提取;两文件在可达历史中存在于 5 个提交;同提交对台账 3 行做的原地脱敏,其旧版本也留在历史中。
- 附带观察:全部提交的作者邮箱为手机号型地址(`15184552744@163.com`),公开即暴露;是否更换 commit identity 由用户决定。

### 2.5 分级结论(任务 1)

- **真实凭据(阻断):0**;**疑似需人工复核:0**(31 条全部完成定性,无遗留)。
- **隐私串(非凭据类,公开阻断)**:客户人名/项目名/路径确认仍在本地与 origin 的可达历史中——按既有决定走"新仓干净初始提交"即消解;若坚持公开现仓库历史则为阻断项。

---

## 三、任务 2:素材逐资产再分发许可/署名核查

### 3.1 两个公布面的区分

- **仓库 tracked 面(切 public 即随仓库公开)**:资产溯源**基本齐备**(见 3.2)。
- **data/external-assets 面(本地 gitignored,公开暴露途径是 GitHub Release `asset-library-v1` 素材包)**:条目级许可覆盖 **13.6%**,且发布合同仍 fail-open(见 3.3)——** Release 面维持 NO-GO**。

### 3.2 tracked 面盘点(结论:有记录,可复核)

| 资产组 | 数量 | 许可/来源记录 |
|---|---:|---|
| `packages/deep-engine/lab/assets/*.glb`(Khronos glTF Sample) | 7 | **7/7 逐资产**:sources.json 含 sourceUrl、gitBlobSha1、SHA-256、SPDX(CC-BY-4.0/CC0)、作者、本地 notice 文件——仓内标杆 |
| `apps/web/public/assets/nature-kit/`(Kenney Nature Kit) | 48 glb + 192 png 缩略图 | License.txt 入目录(Kenney CC0 系) |
| `apps/web/public/brand/`(品牌图) | 4 png | 自产,溯源与 SHA-256 记录于 `docs/specs/product-alpaca-logo-2026-09-21.md`,THIRD_PARTY_NOTICES 有专段 |
| `apps/web/public/samples/*.csv`(BatteryLife v11 / TEMPEST) | 7 csv | THIRD_PARTY_NOTICES.md:38-39 登记(MIT+引用 / CC BY 4.0 + Zenodo 记录号);`battery-examples.manifest.json` 逐文件 source+SHA-256 |
| `apps/api/assets/vision-sample/`(YOLOX-Nano 权重+示例图) | 2 | LICENSE-YOLOX 随包(Apache-2.0)、README 含官方下载 URL 与 SHA-256 |
| `apps/api/models/battery/`、`apps/battery-native-runtime/models/`(自训 ONNX,36.0 MB/21.5 MB) | 8 | 自有模型转换物,candidate-manifests.json 记录 SHA-256/checkpoint 身份;生产批准状态 candidate(如实未批) |
| 字体 | 0 | 不随包分发(宿主机加载),与 notices §字体段一致 |

### 3.3 data/external-assets 与 Release 面缺口

条目级覆盖统计(catalog/manifest 可量化条目):

| 清单 | 条目 | 带许可 | 带来源 URL |
|---|---:|---:|---:|
| `source-a/catalog.json` + `audit.json` | 1,550 / 1,551 | **0** | **0** |
| `source-b/catalog.json` | 100 | 100(author/originUrl/attribution 齐) | 100 |
| `environment-materials/catalog.json` | 127 | 127(CC0-1.0) | **0**(仅 sourceCategory 文字) |
| `open-packs/catalog.json` | 17 包 | 17(包级 CC0+URL+SHA-256) | 17(包级) |
| `industrial-format-plan/corpus-manifest.json` downloadedSamples | 7 | **0** | 7(source+SHA-256) |
| 顶层 `pack.manifest.json`(Release v1.1.0 载荷) | 5,131 文件 | **0**(仅 path+sha256) | 0 |

**条目级合计:1,794 条中 244 条带许可记录 = 13.6%(缺失 86.4%,全部集中在 source-a)。**

**发布合同矛盾仍在(09-24 P0-03 未闭合)**:顶层 `pack.manifest.json` 已从 v1.0.0/4,653 文件升至 **v1.1.0/5,131 文件**、仍 `publicationStatus: "published"` + `license: "SEE LICENSING.md"`,而 `source-a/audit.json` 仍 `defaultPublicationStatus: "review-required"` 且将 `asset-level-provenance`、`publication-license-status`、`brand-and-metadata-review` 列为 required metadata——审计器依旧 fail-open。

**缺失记录典型例子(路径级,≤10)**

1. `data/external-assets/source-a/catalog.json` — 1,550 条无 license/source/author(Release 公开面最大缺口)
2. `data/external-assets/pack.manifest.json` — 5,131 文件仅 path+sha256,`published` + `SEE LICENSING.md` fail-open
3. `data/external-assets/source-a/audit.json` — 1,551 items 0 许可字段,与上层 manifest `published` 直接矛盾
4. `data/external-assets/environment-materials/catalog.json` — 127 条有 CC0 无来源 URL(仅"Pure Skies"类目文字)
5. `data/external-assets/industrial-format-plan/corpus-manifest.json` — downloadedSamples 7 条有 source+SHA-256 无 license 字段;`repositoryLicenseContext` 仍写旧 DMCSL-1.0/source-available/非 OSI 口径(与 09-25 已切的 DMS-MIT-ER-1.0 冲突,合同漂移)
6. `data/external-assets/conformance/gltf-sample-assets/` — 521 文件整仓 vendored,仅靠上游 README 逐模型 credit,无本地逐资产 manifest 映射
7. `data/external-assets/robotics/mujoco-menagerie/` — 471 文件,目录级 LICENSE,无逐模型许可映射
8. `data/external-assets/source-b-a/|b/|c/catalog.json` — 三个 0 条目空目录残留
9. `apps/web/public/samples/battery-examples.manifest.json` — tracked 文件内含个人路径 `D:/Documents/New project 3`(P1-02 类)
10. `packages/deep-engine/fixtures/benchmark-assets/manifests-v1.json` — 仍含 2 处个人盘符绝对路径(`D:\Download\BIMFACE示例模型.rvt`、`D:\Documents\bim\bim-studio\test-model\Snowdon Towers….rvt`;09-24 P1-02 项未闭合)

### 3.4 分级结论(任务 2)

- 仓库 tracked 面:有记录可复核(个别个人路径属 P1-02 清理项,不属许可缺口)。
- Release 素材面:**缺口比例 86.4%(条目级)**,且 fail-open 发布合同未修——维持 09-24 的"素材 Release 不可暴露给公众"结论。

---

## 四、与 09-24 审计的差异

| 09-24 阻断项 | 当前状态 | 差异说明 |
|---|---|---|
| P0-05 全历史秘密扫描未完成 | **仓库内历史+工作树:已完成工具级扫描,0 真实凭据** | 从"启发式未命中"升级为 gitleaks v8.30.1 全 refs 扫描;剩余仅 Release 附件/大二进制未扫、GitHub 原生 secret scanning 待公开后开启 |
| 隐私清理收尾(总账 09-24 计划 filter-repo+强推) | **确认未执行**;决定改为"历史不重写,公开发布走新仓干净初始提交"(e9c34aca 提交信息) | 隐私轴从"计划中"变为"已决断但现历史仍含敏感串"——新仓路线为公开前置条件 |
| P0-03 素材 Release 无逐资产许可 | **部分改善,未达标** | source-b 100/100 approved、environment-materials 127/127 CC0、open-packs 17/17 包级、TEMPEST/BatteryLife 入 notices;source-a 1,550 条仍为 0;manifest v1.0.0→v1.1.0(5,131 文件)但 fail-open 与 review-required 矛盾原样保留;GitHub 上 Release tag 仍指向 v1/旧 main |
| 许可证口径 | 09-25 已完成 P0-4 整改(README/LICENSE.zh-CN/LICENSING/治理断言统一 DMS-MIT-ER-1.0) | 新发现残留漂移:`corpus-manifest.json` 的 repositoryLicenseContext 仍是 DMCSL-1.0 口径 |
| P1-02 个人绝对路径 | 部分仍在 | `benchmark-assets/manifests-v1.json` 2 处、`battery-examples.manifest.json` 1 处(tracked) |
| 工作树状态 | 312 条(09-24 为 134 条) | 未跟踪 63 个源文件经扫描 **0 secrets 命中**,可作为后续逐文件审查的干净基线 |

## 五、对"公开 NO-GO→可复核"的影响判断

1. **任务 1(凭据轴):PASS。** 31 条命中全部为夹具哈希/占位符/校验和误报,0 阻断;09-24 五项公开阻断中的"未完成可信全历史秘密扫描"一项可标记为**已完成(仓库内范围)**。剩余尾巴:Release 附件未扫、GitHub 原生扫描公开后开启。
2. **隐私轴:维持阻断条件但路径明确。** 当前可达历史含客户串且 filter-repo 未执行;按已记录的"新仓干净初始提交"决策执行即可消解,否则维持 NO-GO。
3. **任务 2(素材面):仍 NO-GO。** 条目级许可覆盖 13.6%(缺 86.4% 集中于 source-a),发布合同 fail-open 未修;tracked 面资产溯源大体齐备,缺口不随 `git push` 公开,但素材包一旦重新发布仍会暴露。
4. **总判断:整体公开状态仍为 NO-GO,但构成发生变化**——五项阻断中"秘密扫描"一项已可关闭;素材项从"全部为 0"改善为"多目录达标、source-a 与发布合同未闭合";新增确认"新仓干净初始提交"是隐私轴的唯一低成本出路。可复核的下一步顺序:隔离/重建素材 Release(P0-03)→ 决定历史路线(新仓)→ 公开后开启 GitHub 原生扫描。
