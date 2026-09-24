# 本地 / SaaS 项目迁移与发布一致性核查

日期：2026-09-24

## 结论

`.bimproject` 已经是本地工作台与 SaaS 之间的项目迁移格式，不需要另建导出包。当前 v1 包能双向迁移场景、二维应用、模型、项目资源、脚本依赖以及数据连接/数据集/管道描述；凭据不会进入包，目标环境需要重新配置连接密钥。

SQLite 与 PostgreSQL 复用同一 `MetadataStore` 和 API 路由，上层项目迁移客户端不区分存储后端。Tauri 本地 API 已装配 Native、Android 和 Three 三类发布入口：Native/Android 使用可搬迁资源闭包，Three 复用已安装桌面 EXE 作为固定通用启动器，将经哈希校验的只读场景负载附加到交付副本。安装版不再依赖 Cargo、pnpm、源码工作区或逐场景重编译。

## 现状核查

### 1. 全仓关键词与未跟踪文件

- 项目包入口：`apps/web/src/delivery/projectTransferModel.ts`、`projectTransferArchive.ts`、`projectTransferImport.ts`、`projectTransferRemap.ts`、`ProjectTransferDialog.tsx`。
- 本地存储入口：`apps/api/src/sqliteStore.ts`、`objects.ts`、`store.ts`。
- 发布入口：`sceneRoutes.ts`、`nativeSceneCandidateRoutes.ts`、`sceneStandaloneExecutableRoutes.ts`、`threeSceneViewerExecutableRoutes.ts`、`dashboardNativeStartup.ts`、`dashboardOfflineArchiveDownloadRoutes.ts`。
- `git status --short` 显示 Tauri 本地 API、WASM、Native、Android 与 AI 正在并行收口；本次只修改发布归档、Tauri 通用启动器与部署接线，不触碰 Three/Rust/WASM 渲染器热路径。

### 2. 契约层

- `.bimproject` 使用现有 `ProjectRecord`、`SceneSnapshot`、`ApplicationDocument`、`DataConnectionRecord`、`DataDatasetRecord`、`DataPipelineDefinition` 和 `ProjectAssetRecord`，没有第二套业务合同。
- SQLite 和 PostgreSQL 都继承 `JsonStore` 的业务实现并实现同一个 `MetadataStore`；差异只在 `persistDocument`。
- 脚本依赖使用 `ApplicationScriptDependency`，导入后重新上传并把应用内依赖映射到目标项目记录。

### 3. 依赖与部署配置

- 项目包继续使用已有 `jszip` 和浏览器 `crypto.subtle`，未新增依赖。
- SQLite 使用 Node 24 内置 `node:sqlite`；大文件仍写入本地文件目录，不塞进 SQLite。
- Three WebView 安装版使用 `THREE_SCENE_VIEWER_LAUNCHER_EXECUTABLE` 指向固定通用启动器；源码服务仍可用 `THREE_SCENE_VIEWER_BUILDER_SCRIPT` 作为兼容回退。
- Deep Native 新候选需要 `NATIVE_SCENE_VERIFIER_EXECUTABLE`。
- Dashboard Native/Android 需要 `DASHBOARD_NATIVE_DEPLOYMENT_FILE`；Android 还要求模板 APK 与 Android build-tools，签名可由部署默认身份或请求级 keystore 提供。

### 4. 消费方

- `ProjectTransferDialog` 的导出与导入都调用统一 `api` 客户端；Tauri 本地模式接入完整本机 API 后，调用路径与 SaaS 相同，仅 `baseUrl` 和认证令牌不同。
- 场景发布页消费 Three WebView 与 Deep Native 路由；二维应用离线发布入口消费 Dashboard candidate 路由，并从候选声明的 `downloadFormats` 决定是否显示 APK。

### 5. 测试与既有证据

- 既有项目包测试已经覆盖清单校验、哈希篡改、缺文件、取消、断点续导、替换文件后失效重做、ID 重映射与凭据剔除。
- 既有 Android 报告：`docs/reports/android-publication-integration-2026-09-24.md`。
- 既有 Native 报告：`docs/reports/native-publication-integration-2026-09-24.md`。

### 6. 规格与交接

- `docs/handoffs/gpt-handoff-2026-09-24.md` 已明确：复用 `.bimproject` 双向迁移，不新增格式；本地版复用现有 API 发布链，不另建打包器。
- `docs/specs/scene-native-publication-evidence-2026-09-15.md` 明确 Native 候选必须绑定服务端配置的真实可执行程序；未配置时返回 503。
- `docs/specs/scene-client-package-integrity-2026-09-15.md` 规定 Three/Native 包的身份与完整性门禁。

## `.bimproject` v1 已有能力

| 内容 | 导出 | 导入行为 |
| --- | --- | --- |
| 场景 | `scenes` 完整快照 | 新 ID、目标项目 ID，模型/资源/数据引用重映射，清除旧发布时间 |
| 二维应用 | `applications` 完整文档 | 新应用 ID，内嵌场景与资产引用重映射，revision 从 1 开始 |
| 模型 | 优先携带 ready 的 GLB/USDZ/ZIP；缺失项仍进入清单 | 先上传并等待转换 ready，再保存场景/应用 |
| 图片、视频、环境、PBR 资源 | 主文件及贴图进入 `files` | 上传到目标项目并重写 URL/asset ID |
| 脚本依赖 | 去重后的模块文件、specifier 与哈希信息 | 重新上传，应用只引用目标项目依赖记录 |
| 数据源描述 | 连接、数据集、管道 | 按连接→数据集→管道顺序创建并重映射 ID |
| 版本信息 | 场景/应用版本清单 | 用作交付说明；不会把旧发布指针直接写入目标环境 |

归档每文件上限 512 MiB、总展开上限 1 GiB，文件路径受白名单约束，内容使用 SHA-256 和字节数校验。缺文件不会静默丢弃，导入前必须补齐或映射替代文件。未完成导入保存 checkpoint；文件替换会使依赖该文件的模型、资源、场景和应用步骤失效并重做。

## 凭据边界

- 非 simulation 连接只保留连接类型、名称和结构描述，`config` 导出为空且 `enabled=false`。
- simulation 连接仅保留 `sim:` URL 中 `rows`、`seed`、`interval`、`start` 四个安全参数。
- 递归清理 `password`、`passwordEnv`、token、API key、secret、credential、authorization、headers 和 direct binding。
- HTTP(S) URL 会清除 user/password 以及 token、secret、key、signature、authorization、`x-amz-*` 查询参数。

因此“无缝”指内容、引用与编辑能力可迁移，不代表把数据库密码、现场 PLC 凭据或云签名密钥复制到另一环境。

## 本地与 SaaS 一致性

本地和 SaaS 的迁移路径都是：

`同一 Web 客户端 → 同一 API 路由合同 → MetadataStore → SQLite 或 PostgreSQL`

SQLite 和 PostgreSQL 的项目、资源元数据、数据连接、数据集、管道、场景与应用操作来自同一 `JsonStore` 业务实现。本轮扩展 `sqliteStore.test.ts`，确认这些记录写入 SQLite 后能够关闭并重新打开恢复。项目包导入器不读取存储类型；同一归档分别对“本地目标”和“SaaS 目标”执行时，调用了完全相同的模型、资源、脚本依赖、数据源、场景和应用 API 序列。

本机能够连接回环 PostgreSQL（5432）和 MinIO（9000），本轮已用两套真实 HTTP API 完成 `SQLite/本地文件 → PostgreSQL/MinIO → SQLite/本地文件` 往返。当前环境没有外部 SaaS 地址或可识别的部署实例；该结果证明同一客户端合同和两种存储后端一致，不等同于公网部署的网络、网关和身份系统验收。

真实样本包含 1 个 GLB、1 张 PNG、1 个已打包脚本依赖、2 个数据连接（simulation 与带假凭据的 PostgreSQL 描述）、2 个数据集、1 条管道、1 个带 dataset 绑定的场景以及 1 个应用。两次导出的三项资源字节与 SHA-256 全部一致：GLB `ed52f719…3d54e`、脚本 `29c45598…7fb22`、PNG `e8ae14f1…cd8e5`；场景的模型 ID、dataset ID 和应用脚本依赖均在两个目标项目中重映射并能读取。项目包整体哈希不同是预期行为，因为目标项目/对象 ID、创建时间和归档清单身份会重写。

首轮实测暴露出脚本依赖会被 esbuild 二次打包，字节从 377 变成 384。迁移导入现改用同一上传入口的 `prepared=1` 模式：服务端仍做 JavaScript 语法校验，但对项目包中已经冻结且有归档 SHA 的模块原样持久化。修复后第三次真实往返通过；未新增格式或平行打包器。

## 发布能力核对

### API 源码层

- Web 发布：完整 API 默认注册场景/应用保存与公开读取。
- Three WebView：正式 EXE 路由优先复用固定通用启动器。上传的 `.bimscene.zip` 会验证包身份、展开大小、每文件 SHA-256、整体内容身份以及发布版本绑定，再生成只读负载；只有 launcher 与源码 builder 都未配置时才返回 `THREE_WEBVIEW_LAUNCHER_UNAVAILABLE` 503。
- Deep Native：候选路由始终存在；未配置 verifier 时明确返回 503。历史发布若已冻结 Native EXE，下载路由可以继续读取冻结字节。
- Dashboard Native/Android：只在 `DASHBOARD_NATIVE_DEPLOYMENT_FILE` 有效并完成权威编译器/窗口验证器装配后注册；APK 还取决于 Android 模板和 build-tools。

### 当前 Tauri 本地 API 运行包实测

以 `apps/desktop/local-api-bundle`、SQLite、本地对象存储和 desktop-local 令牌启动生产 sidecar，并使用清单物化的真实发布配置：

| 入口 | 结果 | 含义 |
| --- | --- | --- |
| `POST .../native-candidates` | `400`（缺合法快照） | 路由与真实 verifier 已配置，不再是配置缺失的 503 |
| `POST .../three-webview-executable` | `200`，随后独立 EXE inspector 成功 | sidecar 使用安装版主程序生成场景 EXE；下载物能在独立进程校验 package/content/payload 身份与只读标记 |
| `POST .../applications/.../dashboard-candidates` | `400`（缺权威请求） | Dashboard Native/Android 路由已完成启动注册 |
| Android 工具链 | `apksigner 0.9`、`zipalign` 通过 | 双 ABI 模板、build-tools 与最小 JRE 已随资源闭包配置 |

这证明本地 API 已同时接通编辑、数据、Native、Android 和 Three 发布服务。Three 下载过程没有启动 Cargo、pnpm 或 Tauri build；固定启动器仅复制、写入可选品牌资源并追加经过 SHA-256 索引的只读负载。

## 真实剩余缺口

1. 本地 Dashboard Android 已默认支持请求级签名；如以后提供部署默认签名，keystore 和口令不能进入项目包、日志或前端持久化。
2. Three 交付副本会更新 PE 品牌资源并追加场景负载；若发行环境启用 Windows 代码签名，必须在生成副本后签名，不能沿用基础启动器的签名结论。当前链路未配置发布证书，因此不宣称场景 EXE 已签名。
3. 同一个真实模型/数据绑定项目已完成 SQLite 与 PostgreSQL/MinIO 的 `.bimproject` 双向导入和资源身份对比；仍缺的是外部 SaaS 部署上的 Web、Three、Native、Android 四种发布对比。当前没有外部 SaaS 地址，未把本机服务器模式冒充公网部署证据。
4. `.bimproject` v1 是作者项目迁移包，不是整站备份。当前未迁移数据端点密钥、语义模型、AI 运行记录、视觉中心任务/模型、Unity 资源和发布历史；若“所有功能无缝”要求这些项目级配置也跟随迁移，应在现有 schema 的版本升级中逐项增加，不能另建平行格式。凭据和历史发布产物仍应保持环境隔离。

## 本轮验证

- Web 项目包专项：原迁移回归通过；Three/Native 归档专项 `14/14` 通过，并覆盖发布级名称/图标进入清单、文件索引和内容身份。
- 项目迁移专项：`6/6` 通过；脚本依赖服务 `4/4` 通过，新增已打包模块字节保持测试。
- 真实存储往返：`SQLite/local → PostgreSQL/MinIO → SQLite/local` 通过；两端资源闭包均为模型/资源/依赖/连接/数据集/管道/场景/应用 `1/1/1/2/2/1/1/1`，凭据检索结果为 false。证据：`test-output/project-transfer-storage-parity/result.json`。
- API Three 通用启动器专项：`2 files / 3 tests` 通过，覆盖固定 PE 复用、尾包 SHA、只读清单、资源路径重写、篡改拒绝和未配置时精确 503。
- `apps/api` TypeScript：通过。
- `apps/web` TypeScript：通过。
- `git diff --check`：本轮代码无空白错误。
- Tauri Rust：`9/9` 通过，包含发布清单物化、当前 EXE 标记解析、Three 负载身份/路径/范围/文件 SHA 校验与篡改拒绝。
- 生产 sidecar smoke：认证 200、Native 路由 400、Dashboard/Android 路由 400、Three 下载 200；下载后的独立 EXE 使用 `--inspect-scene-viewer-payload` 成功确认只读状态和 package/content/payload 身份。
- 最终桌面基础 EXE：58,181,120 bytes，SHA-256 `a945c573cb00f81cc0d84fc12c80c1076199edaaeb9d5680e81f07dd9be1ab1e`。本地 sidecar 从该固定启动器真实生成 `Factory Viewer.exe`：58,183,856 bytes，SHA-256 `73fdccc67341ba91fd80f5c306a76823195825ab80b87627a31f87e59c0092bf`，package `522c6957e2f90d41`，payload SHA-256 `d3701cb97e85913080a613c2d0cc3d75bb516bd01474ebabace02a58253715eb`，`readOnly=true`。
- 最终独立 EXE 真窗口通过：WebView `readyState=complete`、无 fatal、canvas 1800×1125；系统标题栏亮度 32（深色），页面截图采样 367 种颜色。工具坞通过 WebView2 CDP 真点击后由展开变为折叠，`aria-expanded` 从 `true` 变为 `false`，宽度从 269.6 px 变为 44.6 px，页面截图底部区域有 8,547 个采样像素变化。证据：`test-output/final-three-scene-viewer/window-smoke.json`、`webview-before.png`、`webview-after-toggle.png`。

## 可搬迁发布资源闭包

生成命令：`node apps/api/scripts/prepare-local-publication-runtime.mjs --output <local-api-deployment-root>`。

输出清单 `publication-runtime.json` 使用相对路径并记录关键文件的字节数和 SHA-256。资源包括 Deep Native release EXE、固定运行包探针、Android 双 ABI 模板 APK、`zipalign.exe`、`apksigner.jar`，以及由 JDK `jlink` 生成且只包含 `java.base,java.logging` 的最小 JRE。

清单中的环境映射为：

- `NATIVE_SCENE_VERIFIER_EXECUTABLE=publication/native/deep-engine-native.exe`；
- `JAVA_HOME=publication/android/jre`；
- `DASHBOARD_NATIVE_DEPLOYMENT_FILE=@generated:workspace/config/dashboard-native.json`。
- `THREE_SCENE_VIEWER_LAUNCHER_EXECUTABLE=@runtime:current-executable`。

Tauri 启动时会将 `dashboardDeploymentTemplate` 中的资源引用解析为安装资源绝对路径，将生成配置写入可写工作目录，再注入上述环境变量。固定设备指纹仍适用于服务器部署；桌面本地模式新增 `deviceFingerprint.mode=runtime-local`，启动时用固定探针运行真实 Native 窗口，读取本机 GPU 指纹并固定到本次服务生命周期。该模式只接受 `BIM_STUDIO_DEPLOYMENT_MODE=desktop-local`。

真实 smoke 输出位于 `test-output/local-publication-runtime-smoke`：

- Native EXE：20,664,832 bytes，SHA-256 `3145b55aa57b1114117f94b47e8a36f1e5ade068b3057193e882775bfb645908`；
- Android 模板：23,487,046 bytes，SHA-256 `609e35e81930489fd785100507fdd19e9e39857cc43d842014d4801abe1e05f2`；
- `apksigner 0.9` 从闭包 JRE 成功启动，`zipalign -c -P 16 -v 4` 通过；
- 闭包 Native EXE 对固定运行包完成 1 帧 Vulkan 窗口验证，报告 1200×800、`gpuErrorsClean=true`，设备指纹 `32b36c31fa3dad1ad8c9beea224fcd27ce6e580587df9aa39e701d1d01dfa5b4`；指纹仅为本机证据，不写入可搬迁清单。

本轮新增/更新的聚焦证据还包括 Web 归档 `14/14`、API Three `3/3`、Tauri `9/9`；生产 sidecar 已生成并独立执行通用 Three 场景 EXE。

## Three 安装版通用启动器

固定启动器复用安装版 `bim-studio-desktop.exe`，发布时不会改原安装文件。API 读取原 EXE 私有副本，按交付品牌更新名称/图标资源，然后追加 `DMTHREE1` 尾包。尾包包含独立 SHA-256、包 ID、源归档 content hash、文件偏移/字节数/内容类型以及每文件 SHA-256。Tauri 启动时只读取自身末尾的有界负载；没有尾包时仍进入完整编辑器，有有效尾包时创建独立 `scene-viewer` 窗口。

只读窗口使用单独 capability：不具备服务器配置、凭据保存或本地 API 启动命令；新窗口请求全部拒绝。自定义 `scene-viewer` 协议只提供安装包内前端静态资源和尾包内冻结资源，响应启用 `no-store`、`nosniff` 与只读 CSP。运行时注入既有 `scene-viewer-delivery` 标记并复用 `SceneViewerRoot`，没有复制第二套播放器。
