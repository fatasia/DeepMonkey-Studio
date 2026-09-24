# Native 发布接入核查与修复记录（2026-09-24）

## 现状核查

### 已有（不重建）

- 契约层已有 `SceneNativeCompiledPublication`、冻结依赖、兼容报告和 `deep-native` 目标；Native 候选只能由服务端编译及真实窗口验证生成，客户端不能自行声明 EXE 或证据。
- Web 已有完整编排：`scenePublicationActions` 保存快照并创建候选，发布后由 `useScenePublicationArtifacts` / `scenePublicationArtifactRunner` 生成或重试同一版本的 EXE，浏览器下载由 `sceneStandaloneExecutable` 接管。
- API 已有冻结发布版本到 EXE 的正式边界：重新核对依赖、运行包 SHA-256、兼容报告、候选验证时的 EXE SHA-256，再调用 `embedVerifiedNativeArtifact`；请求不能覆盖本机程序路径。
- Native 已有内嵌包读取、`--package` / `--headless-package` 预检、窗口验证和 Windows portable 脚本；现有 D10 规格记录了静态场景真实窗口和断网运行证据。
- 依赖无需新增：Web/API 沿用 React、Fastify、JSZip 和现有下载工具；Native 沿用当前 Rust/winit/wgpu 工程。
- 已有测试覆盖候选权限/过期/并发、冻结版本一致性、EXE SHA 漂移、取消、浏览器 API 读取和任务恢复；已有 `scripts/verify-scene-standalone-executable.mts` 可做隔离的 HTTP→EXE→窗口全链验证。

### 2026-09-24 实际运行核查

- 当前 `.env` 把 `NATIVE_SCENE_VERIFIER_EXECUTABLE` 固定到 `.cache/native-client/deep-engine-native.exe`：16,367,104 字节，2026-09-20；当前 release EXE 为 20,639,744 字节，2026-09-24。两者都能通过基础 `runtime-package-v1.json` 的 headless 预检，但开发服务没有主动提示候选验证使用的是旧构建。
- 对真实保存的 D10 场景调用候选接口：隔离 API 5.98s 返回 `ready`，现用 4100 API 3.10s 返回 `ready`，报告 3 项能力。首次请求在并行开发构建导致 watch 重启时连接中断，随后页面会出现 502；这证明开发态重启会中断长事务，但不能据此认定 Native 编译或窗口验证失败。
- 尚未在本轮验证同一候选的发布、EXE HTTP 字节完整性、内嵌包独立启动及浏览器任务落盘反馈，因此“Native 发布可用”仍不能成立。

### 真实缺口

1. 缺少一条可自动复跑的正式上层闭环证据：保存快照 → 候选 → 发布 → 下载 EXE → 断开 API 后独立启动/预检；历史脚本有能力，但没有成为当前发布改动的稳定门禁。
2. 开发服务可长期引用旧缓存 EXE；候选证据会与旧 EXE 绑定，最新引擎修复不会进入新下载包。启动时缺少可操作诊断。
3. 浏览器记录当前只保存文件名与 ready 状态，不持久化服务端 `X-Native-Artifact-Sha256`、实际字节数或本地落盘确认；需要区分“已生成/已请求下载”和“用户设备已保存”。
4. watch 重启、断网、409/5xx、取消及刷新恢复虽有局部测试，仍缺从页面到底层服务的同一场景故障注入证据。

## 本轮验收

1. 聚焦回归必须能捕获实际故障：下载响应不完整、EXE 身份漂移、旧部署 EXE、服务中断和重复提交至少各有确定性断言。
2. 同一保存快照在真实 API 完成候选、正式发布和 EXE 下载；下载字节是 PE 且含有效内嵌运行包，离线预检/窗口启动通过。
3. 页面明确显示生成、下载请求、失败及重试状态，不把浏览器是否真的保存文件伪装成服务端可证明事实。
4. 不改变 admin/admin、Postgres/MinIO 拓扑、现有发布版本和候选权威边界；不接受客户端传本机路径。
5. 运行相关 Web/API 测试、类型检查和仓库 diff 检查；全局测试由总任务统一执行。

## 设计基线

若需要调整发布界面，对标西门子工业软件的克制状态表达，沿用 `apps/web/src/styles/base.css` 令牌；只增加可操作状态，不新增装饰。浏览器视觉闭环至少覆盖 1280、980、480 及深浅主题两轮。

## 实施与证据

### 根因与修复

- 已确认候选、发布、HTTP 下载和 Native 播放器本身可工作；用户感知“不好用”不是运行包编译器整体失效。
- 实际发布的长期缺陷是 EXE 只有 SHA-256、字节仍从服务启动路径读取。该路径升级后，历史版本会因 SHA 漂移无法再次下载；不升级则新发布一直携带旧引擎。当前 `.cache` 正处于后一种状态。
- 新候选在真实窗口验证后再次读取并校验同一 EXE，将精确字节写入项目私有内容寻址对象库，并在 `SceneNativeCompiledPublication.executable` 保存 key/bytes/SHA-256。发布下载优先读取冻结 EXE；旧记录继续使用部署路径和原 SHA 校验，不伪造迁移。
- 下载路由只依赖发布存储即可注册；带冻结 EXE 的新版本在服务当前未配置 Native 程序时仍可下载。只有旧记录需要启动路径作为兼容来源。
- 冻结 EXE 仍经过 PE 头、DLL 标志、512MiB、哈希、取消和流完整性校验；客户端请求仍不能提供程序路径。
- 未改 UI：现有“已生成”只表示服务端生成并已触发浏览器下载，不能证明用户文件系统已保存。最终页面下载事件需在主任务的浏览器全局门禁复验。

### 真实链路证据

- D10 场景：项目 `4099aab5-8297-4ae4-b3cf-7afb3b9599c9`，场景 `8cde10ca-af44-4c3e-8920-4f3077653765`。
- 修复前 v2 已证明现行链可产出 EXE；修复后 v3：候选 `ready`、报告 `ready`、正式发布成功。
- v3 冻结 EXE：16,367,104 字节，SHA-256 `bbc217f5496ae3481f40df82231cbb0c0ee248bc9d5903d80f30b0fce4cb9948`，记录与私有对象存在。
- 下载：HTTP 200，16,478,139 字节，`Cache-Control: private, no-store`，`X-Native-Artifact-Sha256` 与冻结运行包一致，PE 末尾 `DMDASH01`。
- 下载 EXE 无参数启动：NVIDIA GeForce RTX 4060 Laptop GPU / Vulkan，1200×800 真窗口，出现 `native package recovery checkpoint committed after present`，GPU scope clean。
- 本地证据：`test-output/native-publication-integration-20260924/post-fix-api-download.json`、`post-fix-window.json`、`post-fix-api-download.png`（运行产物不提交）。

### 验证

- 聚焦 Native 发布/API 回归：8 files / 104 tests 通过。
- Candidate compiler 隔离复跑：10/10 通过。
- `@bim-studio/api` 与 `@bim-studio/contracts` TypeScript 类型检查通过。
- API 全量：234 files 通过、1 skipped；4 项失败。其中 `nativeSceneCandidateCompiler` 的并发超时隔离复跑已通过；`dashboardPortableZip` 的许可证旧断言、Windows 测试 EXE 超时和 `scriptGitService` 超时/EBUSY 属并行全量环境与许可证批次，不由本改动引入，需在最终全局门禁统一复跑。

### 最终 release 轮换与 v4 验证

- Native/WASM 共享源收口后执行 `cargo build --release --locked --bin deep-engine-native`，3m41s 构建通过。最终 release EXE 为 20,664,832 字节，SHA-256 `3145b55aa57b1114117f94b47e8a36f1e5ade068b3057193e882775bfb645908`。
- 旧缓存 EXE 已按 SHA 存档到 `.cache/native-client/archive/`，最终 release 通过临时文件校验后原子替换 `.cache/native-client/deep-engine-native.exe`；轮换后缓存 SHA 与 release 完全一致。
- API watcher 子进程已重启，`GET /health` 返回 `{"status":"ok","service":"bim-studio-api"}`。并行源码变更曾在首次 v4 请求前引起一次瞬时断连，watcher 恢复后同一流程完整通过。
- D10 场景 v4：候选 `ready`、报告 `ready`、发布版本 `4`。冻结 EXE 为 20,664,832 字节，SHA-256 与最终 release/服务缓存一致。
- v4 下载 HTTP 200，20,679,611 字节，`Cache-Control: no-store, private`，`X-Native-Artifact-Sha256` 与冻结运行包 SHA 一致；下载件 SHA-256 `6396a9508360c45df127284ccb357a1179a8237e87635b19a538ad2826d4bcaa`，overlay footer magic 为 `DMDASH01`。
- v4 下载 EXE 无参数真实启动通过：NVIDIA GeForce RTX 4060 Laptop GPU / Vulkan，1200×800 客户区，`PrintWindow` 可见内容 39 色，GPU scope clean，首帧后写入 recovery checkpoint。
- 最终本地证据：`test-output/native-publication-integration-20260924/v4-api-download.json`、`v4-window.json`、`v4-api-download.png`（运行产物不提交）。

### 尚待总任务执行

1. 根任务从真实页面点击 Deep Native，捕获浏览器下载事件、任务 ready/失败/重试状态以及 1280/980/480 双主题视觉证据。本子任务的 computer-use 表面没有暴露任何 browser，无法在此处伪造点击证据；API 、下载字节与 Native 真窗口已完成验证。
