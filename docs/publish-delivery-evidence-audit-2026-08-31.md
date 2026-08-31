# 发布与交付闭环证据审计（2026-08-31）

## 审计原则

本审计把“代码存在”“自动化通过”“本机真实运行”“生产交付完成”分开记录。桌面编辑客户端不等于单场景只读客户端发布器；云渲染 Worker 健康也不等于完整远程媒体会话已经验收。

## 结论矩阵

| 能力 | 当前等级 | 本次真实证据 | 仍未证明 |
|---|---|---|---|
| WebGL Web 发布 | 已形成发布闭环 | 发布快照、匿名公开读取、只读路由、工具栏策略和在线全链路通过 | 客户真实大场景与公网部署 |
| WebGPU 优先发布 | 可用且有自动回退 | RTX 4060 上完成 120 对象、73,840 三角面、25 次场景替换、设备丢失恢复到 WebGL；P95 7.2ms，无门禁失败 | WebXR、所有作者效果在 WebGPU 下的等价签署 |
| 云渲染 | 控制面与真实 Worker 就绪 | API/Worker 测试通过；本机 Chromium 真实回环证明 NVIDIA H.265 硬编码，Worker 为 `ready` | 通过生产 API 创建会话、远端浏览器完成 offer/answer、媒体与输入完整链路 |
| Windows 客户端 | 编辑客户端与单场景只读客户端均可生成 | 当前源码重新生成两类 MSI/NSIS；只读包固化发布版本和站内资源，使用独立 viewer 入口与最小 Tauri capability | 干净管理员 Windows 安装/升级/卸载未执行；真实生产大模型包仍需用目标发布版本验收 |

因此四类目标均已有对应运行路径。Windows 交付明确分成“完整编辑客户端”和“单场景只读客户端”，两者没有通过改名混淆。

## 代码边界

### WebGL 与 WebGPU

- 发布合同仅包含 `webgl`、`webgpu-preferred`、`cloud`：`packages/contracts/src/scene.ts`。
- 发布对话框提供三种运行后端、是否允许极速模式和是否显示只读工具栏：`apps/web/src/components/ScenePublicationDialog.tsx`。
- 发布页在加载快照后执行真实 WebGPU adapter 探测；设备不可用或作者效果未签署时自动选择 WebGL：`apps/web/src/rendererCapabilities.ts`、`apps/web/src/hooks/useAppLifecycleEffects.ts`。
- WebGPU 设备丢失时保存当前快照并重建 WebGL renderer：`apps/web/src/hooks/useAppRuntimeEffects.ts`。
- WebGPU 整场替换按对象规模回收 renderer/device，不改变模型几何、纹理或作者画质：`apps/web/src/viewer/webGpuRendererLifecyclePolicy.ts`。

本次删除了产品诊断中已经取消的“8 小时长稳尚未签署”旧口径。短时资源、画质、设备丢失和恢复门禁仍保留。

### 云渲染

- API 控制面只允许已发布快照启动会话，并要求新鲜 Worker 健康、空闲容量和硬件编码证据：`apps/api/src/cloudRenderControl.ts`。
- Worker 使用 Chromium、WebRTC 视频轨和输入 DataChannel；发布作用域拦截非 GET 和越权 API：`apps/cloud-render-worker/src/chromiumRuntime.ts`、`server.ts`、`viewer.ts`。
- 本机临时启动 Worker 后，Chrome CDP 与 WebRTC 回环识别到 `NVIDIA GeForce RTX 4060 Laptop GPU`；H.264 为 OpenH264、AV1 为 libaom，只有 H.265 同时报告 Media Foundation NVIDIA encoder 与 `powerEfficientEncoder=true`，因此只把 H.265 标为硬件编码。这与代码的保守证据策略一致。
- 当前 `.env` 未配置生产 `CLOUD_RENDER_*`，所以本次没有伪造生产 API 到 Worker 的完整媒体会话。

### Windows 客户端与本地模式

- Tauri 首次进入可直接选择“本地工作台”，无需服务器 IP；在线模式保存并校验单一服务器 Origin：`apps/web/src/components/DesktopConnectionGate.tsx`。
- 本地项目、场景、发布版本和模型 Blob 使用客户端 IndexedDB；它不依赖 PostgreSQL、MinIO、Node.js 或 Python：`apps/web/src/adapters/desktopLocalWorkspaceStore.ts`。
- 服务器配置由 Rust 写入应用配置目录，采用临时文件、备份、替换失败回滚和启动恢复：`apps/desktop/src-tauri/src/lib.rs`。
- `frontendDist`、IFC WASM 和 Draco 资源随客户端交付；网络地址只用于用户选择的在线服务和场景中显式引用的外部媒体。

本次发现测试目录残留过期品牌安装包，且早于当前 Web 构建，但旧校验仅检查目录中“存在任意包”，因此错误通过。过期管理安装提取目录现已移入回收站；校验器改为要求当前 `productName + version`，并拒绝早于当前 Web 产物的主程序或安装包，随后重新生成：

| 产物 | 大小 | SHA256 |
|---|---:|---|
| `Industrial Studio_0.1.0_x64_zh-CN.msi` | 20,721,664 bytes | `F03A6C798C26360A2F37E0FDF8BC044B3FE086B46A0CB6DD61A5079308A3BFEE` |
| `Industrial Studio_0.1.0_x64-setup.exe` | 19,885,712 bytes | `4411079A3FD3E7E1A98FF3A4E1BD9BF75D616F8FB81A637EF6673349901F51FC` |

这两个包是完整编辑客户端；单场景只读客户端使用下文的独立发布器生成。

### 单场景只读 Windows 客户端

只读发布器以不可变的 `publishedAt` 精确选择历史发布版本，随后只保留该场景引用的模型与资源。`deliveryTarget=windows-scene-viewer` 与 `rendererMode=webgl|webgpu-preferred` 是两组独立配置；云渲染发布转换成本地客户端时默认采用 WebGPU 优先并允许自动回退 WebGL，不把交付载体伪装成渲染后端。

实现边界：

- `apps/desktop/scripts/build-scene-viewer.mjs` 负责版本选择、资源固化、专用 Web 构建和 Tauri 动态打包。
- `apps/web/src/delivery/SceneViewerRoot.tsx` 是专用浏览入口，不加载 `App.tsx`、编辑器样式、Monaco、场景管理、拓扑或参数化工作台。
- `apps/web/src/delivery/sceneViewerDelivery.ts` 只允许只读 API 合同；写请求返回 405，未知接口返回 404。
- `apps/desktop/src-tauri/capabilities/scene-viewer.json` 不暴露服务器配置读写能力；生成配置只激活该 capability。
- 生成包的 CSP 将连接限制为 `'self'` 和 `ipc:`；运行时不会拉取本项目资源，也不会启动实时数据、视觉轮询或 WebSocket。
- 发布工具栏是交付选项，可使用发布版本原设置，也可在打包时明确显示或隐藏；无编辑导航和保存写操作。

文件模式可用于离线验收，API 模式用于选取生产发布版本。令牌通过环境变量名传入，避免落入命令历史：

```powershell
pnpm --filter @bim-studio/desktop bundle:scene-viewer -- `
  --api-origin https://studio.example.com `
  --project-id project-1 --scene-id scene-1 `
  --published-at 2026-08-31T08:00:00.000Z `
  --token-env BIM_STUDIO_RELEASE_TOKEN `
  --renderer published --toolbar published

pnpm --filter @bim-studio/desktop verify:scene-viewer -- `
  .scene-viewer-build/<package-id>
```

本机使用包含两个三维图元和一个标注的发布夹具完成真实 Tauri 构建，生成结果如下：

| 只读产物 | 大小 | SHA256 |
|---|---:|---|
| `只读客户端验收_0.1.0_x64_zh-CN.msi` | 10,620,928 bytes | `2FCBFF806AF57B5A0C09C606176B422269D64406A3044D10BB5405AC16C8D08A` |
| `只读客户端验收_0.1.0_x64-setup.exe` | 9,698,841 bytes | `F0E25E85D7B041BD02C627DC2324D025056FBAEA4D168C6B3FE64F845F57DF33` |

安装程序内的主程序已真实启动并保持运行 6 秒；该进程的 TCP 连接数为 0。校验器同时验证发布/项目 SHA-256、每个资源的大小与摘要、模型 URL 全部本地化、viewer-only Vite 入口、只读 capability 和无 HTTP/WS 的 CSP。

仍需如实保留三项限制：夹具安装包只含图元和标注，资源下载与摘要改写由真实 HTTP 字节测试覆盖，但尚未用客户生产 GLB 生成安装包；作者行为脚本和实时数据在离线只读包中不执行；WebView2 使用轻量 bootstrapper，目标机若没有 WebView2 Runtime，安装阶段仍可能需要网络，安装完成后的项目资源不依赖网络。

### 原生启动与无 Docker

- `pnpm dev:local` 默认编排 PostgreSQL、MinIO、API 和 Tauri；`web`、`services`、`check` 具有独立目标：`scripts/start-local.mjs`。
- `pnpm deploy:cloud` 使用 Windows 计划任务，Linux 使用 systemd；运行脚本、工作区脚本和包脚本没有 Docker/Compose 路径。
- 本次在 Windows PowerShell 5.1 真实执行发现部署脚本错误使用现代 .NET 哈希 API，且无 BOM 的中文脚本会被 5.1 错误解码。现已改为 .NET Framework 兼容 SHA-256，并添加 UTF-8 BOM。
- 默认 `.env` 缺少生产管理员密码和会话密钥时，预检会按设计阻断；使用仅存在于审计进程的临时合规值后，PostgreSQL 与 MinIO 真实预检通过，未把临时值写入仓库。

## 本次执行证据

| 命令 | 结果 |
|---|---|
| Web 发布/渲染相关单元测试 | 5 文件、21 测试通过 |
| API 云渲染与生产托管测试 | 5 文件、21 测试通过 |
| Cloud Render Worker 测试 | 4 文件、13 测试通过 |
| `cargo test` 桌面 Host | 3 测试通过 |
| `pnpm dev:local:check` | PostgreSQL、MinIO、API、Web 均可达 |
| `pnpm gate:production-artifact` | 通过 |
| `pnpm gate:webgpu` | WebGL/WebGPU、画质比较、25 次切换、设备丢失回退通过；SSIM 0.98762 |
| `pnpm gate:online-flow` | 登录、保存、离线恢复、浏览、发布、匿名公开读取通过 |
| 临时启动真实云渲染 Worker + `/v1/health` | RTX 4060、H.265 硬编码、状态 `ready` |
| `pnpm deploy:cloud:check`（进程临时合规密钥） | 生产配置、PostgreSQL、MinIO 预检通过 |
| `pnpm desktop:bundle` + `pnpm desktop:verify-bundle` | 当前 Industrial Studio MSI/NSIS 生成并通过校验 |
| 只读发布器、Web runtime 与匿名浏览测试 | 5 个文件、12 个聚焦测试通过；精确版本不匹配会阻断 |
| 默认 viewer-only Vite + Tauri 动态构建 | 从源码经 typecheck 生成 MSI/NSIS；只读入口、资源摘要、CSP 与 capability 校验通过 |
| 只读主程序启动与网络观察 | 运行 6 秒稳定，TCP 连接数为 0 |
| 普通 Web 编辑器生产构建 | viewer-only 分支合入后仍通过完整构建与分包预算 |

报告文件：`test-output/product-browser/report.json`、`test-output/online-flow/report.json`。

## 真实缺口与建议顺序

1. **当前安装器不是完全离线安装保证。** `webviewInstallMode=downloadBootstrapper` 在目标机缺少 WebView2 时需要网络。Tauri 官方说明 `offlineInstaller` 可完全离线，但约增加 127MB；建议保留当前轻量在线包，并在用户确认体积取舍后增加独立离线安装构建配置，不直接把默认包膨胀。
2. **干净 Windows 生命周期仍未签署。** 已有管理员脚本，但本机本次没有执行真实安装、覆盖升级、配置保留和卸载。正式交付仍需两版本 MSI 与干净管理员虚拟机。
3. **生产模型的只读安装包仍需签署。** 打包核心用真实 HTTP 字节测试验证资源闭合；最终还需选择客户发布版本，生成一次含 GLB/层级/属性的 MSI/NSIS 并在断网环境浏览。
4. **云渲染生产媒体闭环未签署。** 当前真实证据到 Worker 健康和硬编码；仍需配置正式 `CLOUD_RENDER_*`、TURN/TLS 后跑一次已发布场景的创建会话、offer/answer、媒体帧、输入和停止会话。
5. **本地模式缺少 Tauri UI 端到端证据。** IndexedDB 与适配器代码存在，安装包能启动，但还需在打包客户端真实完成创建项目、导入模型、保存、重启恢复、导出、切换服务器和断网回本地模式。
6. **一键云服务不包含 GPU Worker 编排。** `deploy:cloud` 负责 Web/API 与生产存储；GPU Worker 仍是独立进程。这适合 GPU 节点分离，但交付文档应明确两台机器/两个原生服务的启动顺序，不能称“一条命令启动全部云渲染”。

官方依据：

- Tauri Windows 安装器说明：<https://v2.tauri.app/distribute/windows-installer/>
- Microsoft WebView2 离线分发说明：<https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution>

## 不应在本次临时补做

- 不把完整编辑客户端改名成只读发布客户端；两类构建保持独立入口和能力集合。
- 不在未确认约 127MB 体积取舍前把默认安装器切成 `offlineInstaller`。
- 不用 Mock Worker 测试代替真实生产 WebRTC 会话证据。
- 不恢复用户已经取消的 WebGPU 8 小时长稳任务。
