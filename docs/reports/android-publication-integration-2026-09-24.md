# Android 发布接入核查与验收（2026-09-24）

## 现状核查

### 已有（不重建）

- 合同与运行时：Android 与 Windows 共用 Dashboard 候选运行包/DMDA；`packages/deep-scene-viewer-android` 只提供 `NativeActivity` 外壳，继续复用 `deep-engine-native` 的播放器模块。
- 构建与依赖：`packages/deep-scene-viewer-android/Cargo.toml` 已固定 `winit 0.30.13`、`android-activity 0.6.0`；`apps/api/scripts/build-android-template.mjs` 已能把 arm64/x86_64 `.so`、manifest 和占位运行包装入模板 APK。
- 服务端消费方：`dashboardAndroidApk.ts` 已实现运行包注入、`zipalign -p`、请求级或部署级签名和 `apksigner verify`；`dashboardOfflineArchiveDownloadRoutes.ts` 已有私有 `android-apk` 下载路由。
- Web 消费方：`DashboardOfflinePackageEntry.tsx` 已有 APK 下载按钮和请求级 keystore 表单；`dashboardPublicationApi.ts` 已能以 POST 传输签名字节。
- 测试与历史证据：API 有模板注入/签名测试；总账记录了双 ABI 构建与 Android 模拟器安装、启动、Vulkan 渲染和触控画面变化证据。
- 规格：`docs/specs/三端无感发布实现交接-2026-09-15.md` 规定三端共用 Runtime Package，Android 是 Viewer/Player，不另建编辑器或第二套运行时。
- 任务与版本现场：已核对 `docs/active-task-recovery-ledger.md`、`docs/handoffs/gpt-handoff-2026-09-24.md`、Android/Native 发布规格、`git status --short` 与近期 `git log`；工作树有并行任务改动，本轮只在 Android 发布边界增量修改，没有重置或覆盖其他任务。

### 真实缺口

1. API 候选响应已经返回 `downloadFormats`，Web 的 `DashboardCandidatePrepared` 却丢失该字段，页面始终盲目显示 EXE/ZIP/APK，不能表达实际部署能力，也会把未注册路由暴露成无效按钮。
2. Android 部署配置强制要求服务器默认 keystore；这与页面“可上传请求级签名”的能力冲突，使“只允许作者自带签名”的安全部署无法注册 APK 路由。
3. Web 没有表达 Android 签名模式。没有服务器默认签名时仍允许空签名点击，最终只得到服务端错误。
4. 模板 manifest 仍有 `android:debuggable="true"`，不应作为正式发布模板。
5. 缺少一份从底层模板/签名到 API 候选能力、Web 入口和真实 APK 校验的当前版本证据；历史模拟器证据不能自动证明本次接线未回归。
6. 正式 `android-apk` 下载路由把 DMDA 外层归档写入 `assets/runtime-package.json`，但 `android_main` 会把该文件直接交给 `--package`；历史模拟器使用的是手工注入原始运行包，掩盖了正式下载 APK 启动后 schema fail-closed 的问题。
7. 共用 Native 模块已改用 `web_time::Instant`，Android 壳 crate 没有声明 `web-time`，旧 `.so` 掩盖了当前源码无法交叉编译的问题。
8. `apksigner.bat` 通过 `shell:true` 执行，存在参数拼接风险且 Node 会给出弃用警告；改为由 Java 直接运行官方 `apksigner.jar`。

## 本轮验收矩阵

| 层级 | 验收条件 | 状态 |
|---|---|---|
| 合同 | 候选下载格式与 Android 签名模式从 API 原样到达 Web | 通过 |
| API | 无默认 keystore 也可注册 APK 路由；请求签名缺失时给可操作错误 | 通过 |
| Web | 只显示服务端支持的下载目标；需要作者签名时按钮禁用并说明原因 | 通过 |
| 模板 | release manifest 不可调试，双 ABI 模板可重建并通过签名校验 | 通过 |
| 运行 | 聚焦测试、类型检查、APK 内容/对齐/签名校验；模拟器安装启动 | 通过 |

## UI 验收基准

对标西门子工业软件的克制发布流程，沿用 `apps/web/src/styles/base.css` 令牌。下载目标只展示真实能力；不可执行状态同时给出禁用态和原因；错误保留可操作正文；弹层覆盖桌面与 980/480px，不新增平行样式体系。

## 实施结果

- 服务端候选能力新增 `androidSigningMode`，并保留权威 `downloadFormats`；没有部署默认签名时仍注册 APK 能力，但要求请求级 keystore，空签名直接返回 `android_signing_required`。
- Web 按服务端格式渲染 EXE、ZIP、Web、DMDA、APK；`client-required` 模式自动展开签名区，签名未完整时 APK 按钮禁用并给出操作原因。
- APK 路由直接注入候选 `artifact.artifact`（Deep Runtime Package），不再经过 DMDA 序列化；专项路由测试断言 APK 生成器收到 `01 02 03` 原始运行包且 DMDA 生成器未被调用。
- release manifest 已关闭调试；Android 壳补齐 `web-time`，arm64-v8a 与 x86_64 均由当前源码重编；正式诊断改走 `logcat`，不依赖 release 禁止的 `run-as`。
- 模板与发布签名均直接运行官方 `apksigner.jar`，不再经过 shell。
- 新增 `apps/api/scripts/verify-android-publication.mts`：验证注入字节逐字节一致、CRC、zipalign、签名以及模板/运行包/产物 SHA-256。

## 验收证据

### 自动化

- API：5 个聚焦文件，70/70 通过；其中下载路由专项文件 43/43 通过。
- Web：3 个聚焦文件，26/26 通过。
- `@bim-studio/api` 与 `@bim-studio/web`：`tsc --noEmit` 均通过。
- Android：arm64-v8a、x86_64 的 `android-release` 交叉编译均通过。

### 模板与正式发布产物

- 双 ABI 模板：`data/android/deep-scene-viewer-template.apk`，23,487,046 字节，SHA-256 `609e35e81930489fd785100507fdd19e9e39857cc43d842014d4801abe1e05f2`；`native-code` 为 `arm64-v8a`、`x86_64`。
- arm64 模板：`data/android/deep-scene-viewer-template-arm64.apk`，10,699,254 字节，SHA-256 `cbe384dc07d01bfa3da933ab46136c202d47c8ce805224e86dda4b0a4fd506e5`。
- 两个模板均通过 `zipalign -c -p 4`、APK Signature Scheme v2/v3 校验；`minSdk=24`、`targetSdk=35`，`aapt2 dump badging` 不含 `application-debuggable`。
- 正式双 ABI 发布 APK：`test-output/android-publication-dual-abi.apk`，23,487,046 字节，SHA-256 `c175d9f30e5f2e04fa9440e7a44c106cdbc265d86d9535a2cc94447643d68a65`。
- 注入运行包：2,676 字节，逐字节一致，SHA-256 `faf3492550b9a1ae2ba7a7a1d27166499f0f1329be75f5c722dcd1e2c29f42d3`。

### 模拟器底层到上层

- 在线模拟器 `emulator-5554` 执行 `adb install -r` 成功。
- `android.app.NativeActivity` 冷启动成功，`TotalTime=244ms`，进程保持存活。
- release logcat 输出 `--- android_main ---` 与 `package ready: .../runtime-package.json`；没有 `player failed`、panic 或 fatal。
- 触摸前后截图 SHA 变化，画面中的蓝色立方体随交互更新，证明安装、资产提取、运行包解析、渲染与输入链路贯通。

### UI 两轮视觉闭环

1. 默认桌面宽度：离线包弹层层级、遮罩、标题、关闭入口和未发布提示均完整，无裁切。
2. 480×800：弹层收敛到视口内，左右留白、正文换行与关闭热区完整，无横向溢出；验收后已恢复默认 viewport。

十维自评：布局 9、令牌 9、字体 9、交互 9、动效 8、Android 3D 运行 9、信息设计 9、反馈 9、响应式 9、语义与可访问性 9；平均 8.9/10。

## 遗留与边界

- 已完成 x86_64 模拟器真实安装；arm64 当前源码与 arm64-only 模板已构建、对齐和验签。用户于 2026-09-24 明确本轮不要求物理真机测试，因此双 ABI 构建、签名与模拟器安装/启动/渲染/触控构成本轮完成门禁。
- 浏览器全局测试期间出现并行 WASM 任务的 Vite public import overlay；该问题不属于 Android 发布边界，已把精确错误同步给总任务，未用 Android 改动绕过。
