# Native 发布候选与窗口证据

日期：2026-09-15；2026-09-24 更新。服务端候选编译、正常窗口验证、发布租约及 HTTP/浏览器接线已实现；正式交付为内嵌运行包的 Windows EXE，不再以 ZIP 作为 Scene Native 的最终下载格式。

## 部署

API 使用固定服务端配置 `NATIVE_SCENE_VERIFIER_EXECUTABLE` 指定 Native 程序绝对路径。未配置时候选接口返回 503；请求只能提交已保存快照，不能指定程序、命令或自报窗口证据。服务需要可显示正常窗口的 Windows 桌面会话。

```powershell
pnpm --filter @bim-studio/api build
$env:NATIVE_SCENE_VERIFIER_EXECUTABLE = "D:/native/deep-engine-native.exe"
pnpm --filter @bim-studio/api start
```

API build 和 predev 调用 `scripts/build-native-scene-compiler.mjs`，在 `apps/api/dist/native-scene-compiler/` 生成编译 worker、窗口验证模块及 SHA-256 清单。运行时校验模块字节，不读取 Web 源码或临时构建。源文件 hash 清单用于审计。开发测试在各自临时目录构建，不依赖已有 dist。

`NATIVE_SCENE_VERIFIER_EXECUTABLE` 只决定新候选使用哪一版窗口程序。2026-09-24 起，候选通过后会把该次精确 EXE 字节按 SHA-256 冻结到项目私有对象库；新发布的再次下载不依赖当前服务路径，服务升级也不能替换历史发布引擎。旧记录没有冻结 EXE 时继续使用配置路径并严格核对原 SHA-256。

编译器复用 Web v5 转换和兼容检查，使用服务端冻结 GLB；独立 Worker 限时 60 秒，源资源上限 256 MiB，纹理解码沿用 API 的 sharp。窗口 runner 与 CLI 共用核心，复制包及 EXE 到私有临时目录，记录实际执行副本 SHA，生成随机 nonce；超时或取消终止子进程，等待 close 后清理。

## 发布链路

1. 浏览器保存场景并通过引用检查后，向 `POST /api/projects/:projectId/scenes/:sceneId/native-candidates` 提交 `expectedSnapshot`。接口执行登录/项目权限检查、参数白名单和断连取消。
2. 服务冻结依赖及字节，编译候选。未编译字段直接 blocked；静态能力进入正常窗口验证。`--verify-package` 使用普通 Viewer、精确候选包和实际 Presented 计数，每帧检查 GPU 完成、错误 scope/callback；失败不写成功报告。
3. 服务核对运行包 hash、nonce、实际窗口尺寸与帧数、EXE SHA，再用同一编译器 bundle 对原编译结果注入本次证据并重新评估。无需重新读取模型或编译。场景、当前发布、项目和应用依赖变化时拒绝候选。
4. 成功返回不透明 `candidateId`。候选在服务进程内保留 10 分钟，绑定 actor、项目、场景和完整快照；一次服务只运行一个窗口验证。重启后候选失效。注册表最多 16 项，单项 8 MiB、总计 32 MiB 元数据。
5. 浏览器发布请求携带 `nativeCandidateId`。服务 reserve 租约后使用已冻结输入；事务 CAS 成功才 commit 消费 ID，失败 release。同 ID 不能并发发布，成功后不能再次使用。Native 编译包及报告随依赖记录保存，历史导出复用私有字节。

模块位置：`nativeSceneCandidateService.ts` 负责编排，`nativeSceneCandidateRegistry.ts` 管理租约，`nativeSceneCandidateRoutes.ts` 与 `sceneRoutes.ts` 接 HTTP，`scenePublicationActions.ts` 接浏览器。窗口验证 JSON 是本机进程证据，未签名，不作为远程授权凭据。

## 已核验结果

| 范围 | 证据与实际结果 |
|---|---|
| Native 正常窗口入口 | CPU 专项及 CLI 反例通过；BoxTextured 实跑 1200×800（逻辑 960×640、DPI 125%）、Vulkan、3 帧、GPU clean。日志 `test-output/d10-native-window-live.log`；该次 EXE SHA 为 `3f094e1720614df3d47effedd9afb3d128b6878a40df38bb47d44734e4d1b6eb` |
| D09 v4 互通 | Primitives、Box、BoxTextured 及各自十亿单位偏移，共 6 个 headless；近远相机、完整 packet、对象映射相等，源输入不变，坐标帧参与编译图 hash。GPU 报告中只有 3 个近原点样本实际执行 smoke。报告 `test-output/deep2d/scene-interop/56fa5958-ff27-4249-8dbb-3cf75e24b6e3/report.json` |
| 完整候选服务 | 独立临时 JsonStore/LocalObjectStore、来源 SHA 核对后的 BoxTextured、十亿单位位置，真实 capture→worker→窗口→复核 ready→私有 blob 校验→reserve/release/reserve/commit。窗口 Vulkan 1200×800、3 帧、GPU clean，临时项目已删除。报告 `test-output/native-service-real-report.json` |
| 候选服务产物身份 | 编译器 SHA `f1d71e61fadea4f43d39992d8c3905e2e8a4f6d149f5bb4f8e896296c17ae192`；EXE SHA `6be778a10e3747f8bd9426bdb633fa1588e1e5d2a9ef573c400e77ae0797aa70`；运行包字节 SHA `cdb82f74cc9e015e7fc8d7d16849dc0c6d67930ee32c85fa64d803bc35c8d04d` |
| 自动回归 | 共用 runner 17 项、编译/复核 8 项、窗口 API adapter 3 项、prepare 编排 8 项、service 编排 9 项通过。进程替身测试验证故障行为，真实窗口结果以独立报告为准 |

这些运行记录绑定各次明确的源码与 EXE 版本；并行构建产生的新 SHA 不覆盖旧记录。renderer 的 GPU 检查日志仍含 smoke 文本，正常窗口模式由专用 JSON 和实际 Viewer 路径确定。

## 本轮待办

实际 Postgres/MinIO 环境的完整浏览器发布与下载、断网和失败恢复仍需验收。正常窗口截图及完整视觉对照继续按项目验收执行；当前结果限于上述样本和静态能力，不代表任意作者场景可发布。

## 独立 HTTP 到正式 ZIP、同包离线窗口

`scripts/verify-native-publication-http.mts` 创建独立 JsonStore/LocalObjectStore、独立编译 bundle 和 localhost HTTP 服务；执行真实登录、候选窗口、发布、私有产物读取、Web 导出器和正式 ZIP 校验。仅把 Web API 传输定向该 HTTP、下载 Blob 保存到磁盘，没有替换编译或窗口证据。它不是实际 Postgres/MinIO 加浏览器点击下载链。

```powershell
pnpm --filter @bim-studio/api exec tsx ../../scripts/verify-native-publication-http.mts "D:/native/deep-engine-native.exe"
node scripts/run-scene-client-native.mjs "D:/exports/scene.deep-native.bimscene.zip" --native-executable "D:/native/deep-engine-native.exe" --verify-window
```

2026-09-15 实跑目录：`test-output/native-publication-http/d22e72ec-0881-4e2d-a2ce-a342745611bd/`。十亿场景单位偏移的 box 原始快照，经 v4 局部坐标编译发布后，Web 导出 `Native HTTP large origin.deep-native.bimscene.zip`；CLI 验证 8 个负载、11,560 字节。随后正式 launcher 对同一 ZIP 完整校验、从同一 buffer 提取运行包，并用普通窗口检查模式呈现 3 帧。该步骤无需 API；没有执行系统断网故障注入。

| 身份 | 实际记录 |
|---|---|
| ZIP SHA-256 | `547122966b1234d0e473098796c6f7af2d6a0f80c9aa275648c6a9f02d5fe84d` |
| 两次窗口共同的运行包字节 SHA-256 | `2c18f5e33d84123a03a95699901b8408763cd7a35315ef4eca5c6db1dd497b38` |
| 发布候选窗口 | Vulkan、1200×800、12 Presented、GPU clean；EXE SHA `fa788f780ed26c42e745cb710bf8149e6a9307c613f7a81606f134d29130b946`；`window-evidence.json` |
| 同 ZIP 离线窗口 | Vulkan、1200×800、3 Presented、GPU clean；EXE SHA `e72182573db3683d792a5d2e8ddb65862f5d0343485b8a6c975841cc7e9b4ee0`；`offline-window-evidence.json` |

并行构建更新了 EXE，两次身份分别保留，不能合并为同一个可执行版本。原始离线输出在 `offline-window.log`；汇总、候选、发布记录和冻结描述分别为 `report.json`、`candidate.json`、`publication.json`、`dependencies.json`。这些文件包含运行证据，留在忽略的 test-output，不提交为产品资产。

HTTP 专项 23 项覆盖真实鉴权、请求字段限制、服务未配置、blocked、租约并发/过期/他人使用、失败释放、场景/发布/依赖 CAS、私有字节读取及真实 socket 断连。相关 5 文件 76 项通过，API 类型检查通过；launcher 与共用窗口验证器 33 项通过。进程替身只用于失败测试，上表窗口来自真实进程。

发布取消信号作为存储方法的独立选项传入，真正进入串行事务时再次检查，防止排队期间断连或超时仍提交。JsonStore 与继承该事务入口的 PostgresStore 共用此行为；持久化一旦开始，以提交结果为准，不因后续取消造成磁盘与内存分叉。回归覆盖排队 socket 断连、Abort/timeout 和写盘开始后的取消。

## v5 同版本窗口与停止 API 后启动

2026-09-16 复验改用脚本创建的独立 EXE 副本，发布候选和离线启动绑定同一 SHA；正式 ZIP 导出后关闭本次 HTTP 服务，再执行 launcher。未断开操作系统网络。

目录 `test-output/native-publication-http/e324c9e2-c692-4bab-a2fb-68d979f36432/`：十亿偏移 box，v5 相机资源保存世界原点；ZIP 8 文件、11,801 字节，CLI 通过。候选 12 帧、停止 API 后 3 帧，均为 Vulkan 1200×800 正常窗口、GPU clean。

| 身份 | SHA-256 |
|---|---|
| 两次共同 EXE | `3d75c506006d6c9994ed640ea499a5e28492e62421c1ef81de014f411baa351d` |
| ZIP | `05ca4ce20e9354883bf32667445ac30971ae10bd3eba4dfc14de19b2a2e26436` |
| 两次共同运行包字节 | `b95544641797116322f0f9554e17ad885ade58984dbc8c75fd3a80f343f85859` |
| 编译 bundle | `0706da09102be0c79d11511e33f78a11cda4920f55b9d285edd4c720adc2e7d0` |

`report.json` 的 `offlineApiStopped: true` 记录该测试服务已关闭；`window-evidence.json` 与 `offline-window-evidence.json` 分别保留帧数和来源。此结果仍是独立 JsonStore/Local 样本。

## Studio 默认场景的支持范围

普通 Studio 创建的静态 box 仍可能被默认环境、光照、后处理、天气和导航约束阻断。现有正式运行包支持作者相机和预过滤 IBL；尚未接入 Studio 的网格、天空背景、灯光配置、GTAO/SMAA、晴天平方指数雾及导航约束。默认值有实际效果，不能直接当作无效字段删除。

空 `dashboard.widgets` 也不等于无页面效果：场景迁移保留页面外观，页面渲染器仍设置背景色，继续保留该项阻断。已核验的最小源快照与普通 UI 默认场景是两种输入；默认场景的完整支持等待正式渲染配置通道接入。

## 实际 PostgreSQL / MinIO 发布版本复核

2026-09-16 00:07，在工作台对导入的最小十亿坐标 box 真正点击 Deep Native 发布，生成版本 1。项目 `4099aab5-8297-4ae4-b3cf-7afb3b9599c9`，场景 `8cde10ca-af44-4c3e-8920-4f3077653765`，名称“D10 Native v5 浏览器交付验证”。再次下载操作保留同版本，页面显示已生成。

浏览器下载事件未捕获，系统下载目录未找到该 ZIP，故落盘步骤仍未验收。随后用 `scripts/verify-published-native-http.mts` 只读访问同一历史版本、私有资源和真实 Web 导出函数；CLI 验证 8 文件 / 12,133 字节，再将该 ZIP 送入正式 launcher，Vulkan 1200×800 / 3 Presented / GPU clean。公开开发服务未停止，此次不计作断网故障注入。

证据目录：`test-output/d10-browser-native-evidence/b4110c70-99e3-4303-8658-636ab008cefc/`；`report.json` 保存脱敏 manager 的 postgres/minio 配置、API health/meta、源快照、坐标帧、同一运行包和窗口身份。

| 身份 | SHA-256 |
|---|---|
| 导出的 ZIP | `c4e036ba8391d163cee0fe4f59fe8a0c1b9d7174aa842f7aeb2e2083239d0f7c` |
| 已发布与窗口使用的运行包字节 | `80a28d5c1d5dd3868dca0736631b89b1b68ec48e4d979fba4ce2eafea0b33f13` |
| 发布窗口 EXE | `d2b5de1712fba8b2049b238da37b7a3505198c528f74dfb78b5ca9e161e7369a` |
| 本次同包启动 EXE | `5d38bf1d20b527539cf7e0028515b35a7f79fc44b9e59a1d6b4cee8be63802d7` |

发布时 compiler 为 `0706da09102be0c79d11511e33f78a11cda4920f55b9d285edd4c720adc2e7d0`，复核时 bundle 已更新为 `f93890dc65aae019c4b999c041b3e1e320afb93174e392188eb355eb03fd4062`。历史导出复用原编译字节，没有重编译；两个 EXE 与 compiler 身份分别保留。

最后审查补齐：v4/v5 CLI 重算完整相机参数，并独立检查源场景、源对象的未编译字段；Web assessor 同样重算后取并集，删除 deferred 声明不再隐去作者语义。172 项 CLI 矩阵、Web 3294 通过 / 2 跳过、API 954 通过 / 1 跳过。日志 `test-output/d10-cli-source-audit-final.log`、`d10-deferred-web-full.log`、`d10-deferred-api-full.log`。
