# 发布、离线交付与安装启动续作

本轮范围更新：用户已取消 Android 客户端交付。0.2.0 发布和介绍视频不包含 Android 安装包；以下 Android 检查保留为此前的工程记录，不继续构建、安装或验收。当前交付集中在 Windows、冻结离线包、SDK、Docker 和静态在线样例。

## 现状核查

1. 源码/未跟踪检索：场景发布 controller、API 冻结资源 worker、sceneClientPackage、sceneStandaloneExecutable、Tauri scene-viewer 构建器已存在；贴图分支已有 runtime/资源冻结修复，复用其实现。
2. 合同：ScenePublicationDependencies 固定资源 bytes/SHA-256、nativeCompiled 可执行文件与编译身份；交付目标仅 three-webview/deep-native。Windows SceneViewer manifest 已定义只读入口和本地资源。
3. 依赖：JSZip、Sharp、Tauri 2.11、Rust/Cargo、内置本地 API 与 Node CLI 校验器齐备。SDK/NDK/Android emulator 已在本机，deep-test AVD 可枚举；没有连接的 adb 设备。另有独立 Android NativeActivity 壳及模板 APK。
4. 消费方：scenePublicationArtifactRunner→导出 ZIP/独立 EXE；sceneClientPackage→冻结资源 bytes；build-scene-viewer→专用 SceneViewerRoot→裁剪→delivery manifest→Tauri 配置。使用产品 UI 导出与现有 stage-only 构建入口。
5. 测试/证据：sceneClientPackagePreparedNative/SceneNativeFrozenPayload、Node Archive 的实际 ZIP/哈希检查已有；texture 分支当前 CPU 检查完成。9/25 安装/启动/卸载和 E1 生产构建离线闭包有历史证据。本机 10/5 安装产物：MSI 534,992,600 bytes、NSIS 467,494,831 bytes、desktop EXE 79,585,792 bytes；这些是旧产物，不代表本次源码。
6. 规格：已读 13:36 handoff、当前 continuation、studio-texture-delivery、E1 offline 及安装重载规格与恢复台账。保留各条证据实际范围。

**已有（不重建）**：发布版本冻结、纹理内容哈希、Native runtime 编译、ZIP 校验、只读前端裁剪、Windows 打包器和安装验证脚本。

**真实缺口**：当前生产构建的 UI 导出、离线贴图字节、断网重开、Windows 启动路径实证与体积。Android 的模板与工具核查保留为历史记录，按用户最新要求移出本轮交付。

## 执行

### Windows-only 启动验收脚本核查（收尾）

六步复查：源码与未跟踪文件已查本地运行包、JAVA_HOME 和发布验收；清单合同允许 includeAndroid=false 时省略 JAVA_HOME，Rust 启动消费方已兼容；沿用 Node 与 Tauri 依赖；唯一残留消费方是 smoke-local-publication-runtime 无条件解析不存在的 JAVA_HOME；已有 Windows-only 清单与 Rust 测试通过，真实 sidecar smoke 尚未跑；已核对本规格和 SDK/Docker 发行规格。

**已有（不重建）**：Windows-only 运行包、Native 校验器、正式 API 与 Three 通用只读启动器。

**真实缺口**：验收脚本在启动前解析 undefined；仅在清单提供 JAVA_HOME 时注入环境，再运行真实 sidecar 发布链。

修后真实 sidecar smoke 通过：隔离 SQLite/本地对象目录启动、auth=200、Native 与 dashboard 正式路由存在、Three 可执行下载=200；下载 EXE 的只读 payload、内容哈希与 package ID 一致。证据 `test-output/studio-020-local-sidecar-smoke.log` 与 `studio-020-local-sidecar-smoke/inspection.json`。本轮先验证 sidecar 与通用启动器协议；最终 0.2.0 EXE 生成后须复验其身份。

主线程统一构建普通 web/api 和专用 viewer-dist。本分支不竞争 dist/Cargo；先做 CPU 静态包验收，GPU/浏览器轮次串行。模型使用自建棋盘与开放 UV 方块的隔离 QA 副本。只读包使用已有 build-scene-viewer --stage-only --web-dist，不重新写发布器。

Android 工具核查完成：本机 Android SDK、NDK、system-images、deep-test AVD、adb 已有；adb devices 为空。产品使用已有独立 NativeActivity 查看器及本地 APK 注入/签名链，详见下方消费链补查；Tauri mobile 初始化状态不用于判断这条路线。

## 包体积缺口核查

当前 stage-only 使用现有 manifest/pruner。13 个正式冻结资源共 8,212,177 bytes，真实 exporter+archiveConsumer 输出 18 文件、8,285,478 bytes 的 ZIP，正式 Node 校验通过。原始只读前端 89,181,629 bytes；旧裁剪只移除 IFC/physics/download/showcase 等 17,612,431 bytes，加场景后目录仍 79,842,165 bytes。最大误包来自 docs-assets 文档图、samples 示例 CSV 与 dev/pkg 重复调试 WASM；正式 WASM 消费方只使用 /engine-wasm/deep_engine_wasm.js。

已查源码/未跟踪、交付 manifest 合同、现有 Node依赖、pruner 的唯一 stage 消费方、保留/裁剪测试与 E1 规格。已有按冻结内容裁剪不重建；真实缺口是三个无发布引用的 public 目录未裁剪。扩展现有 pruner，只有完整发布 manifest 明示对应路径时保留；保留 engine-wasm/Draco/Basis 和着色器共享静态模块。shaderAuthoring 在 ViewerEngine 静态共享导入链上，不能删 chunk 冒充体积优化。

## Android 消费链补查

初次仅检索 Tauri mobile，入口判断过窄。实际路线为 packages/deep-scene-viewer-android NativeActivity→同 Native CLI / Runtime Package；apps/api/scripts/build-android-template.mjs 组装双 ABI 模板，dashboardAndroidApk 注入当前 runtime-package.json 后 zipalign/apksigner 重签。data/android 的双 ABI 模板 23,487,046 bytes、arm64 模板 10,699,254 bytes，日期 9/24；本地 API bundle 也包含模板与离线 Java/build-tools。当前壳 target/SO 缓存不存在；模板 keystore、SDK、NDK、deep-test AVD 均可用。旧模板可验证当前场景交付链，当前源码模板需协调共享 Native Cargo 构建。

## 本轮 stage 结果

冻结 QA v2 通过正式 publisher/exporter 与全部文件 SHA 校验；ZIP 8,285,478 bytes，13 冻结资源 8,212,177 bytes。专用只读 frontend 从 89,181,629 降至 21,831,046 bytes，移除 67,350,583 bytes。相对已有裁剪的 71,569,198 bytes 再减少 49,738,152 bytes（69.5%），模型与棋盘 assets 另占 8,204,599 bytes。stage-only EXIT 0，当前 source manifest 与 production EXE 构建分别记录。

## 只读安装资源继承核查

全仓/未跟踪已查 createTauriOverlay、Tauri配置契约和既有依赖；消费方 SceneViewerRoot 仅读冻结 manifest/本地资源，scene-viewer capability 仅 core:default，没有 start_local_api，普通编辑器 TauriHostAdapter 才启动 API。现有 overlay 未覆盖父 bundle.resources，因此只读安装器继承完整 API/node_modules/Android工具与转换模型约570MB。已有普通编辑器本地API不重建；真实缺口是只读 overlay 未明确空资源。补 resources=[]（不同于空对象的合并），保留内嵌 frontend 与原有 WebView2 完全离线安装模式；专用输出测试及实际 merged config 构建由主线程验证。

Tauri 合并实际校验：用本机 tauri-build 同款 json_patch crate 已编译 rlib 直接 rustc 小探针，无 Cargo 重建。合并父 tauri.conf.json 与本轮 overlay 后 resources=[] / count=0，offlineInstaller 保留；证据 tauri-merged-config.json。只读窗口数组另补回父配置的深色 backgroundColor，避免原生首帧回默认白底。3 个相关 Node 测试文件 15 tests 通过。

Android CPU 路径：当前冻结 v2→正式 compiler 34f24bf…→651-byte checker 源图编入 336,692-byte runtime→正式 APK 注入与 zipalign/apksigner/verify，通过双 ABI 内嵌 runtime SHA 仲裁。APK 23,487,046 bytes。原 compatibility 仍为 blocked：缺窗口运行证据及 engineeringAnalysis/对象动画字段未编译；本 QA 产物不改变发布门。
