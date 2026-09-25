# Deep Monkey Studio Desktop

M7 的 Tauri 2 薄宿主。它打包 `apps/web` 的同一份静态产物，只负责桌面系统边界，不复制编辑器业务逻辑。

客户端启动时提供两种明确模式，二者复用同一套编辑器，不复制业务逻辑：

- **本地工作台**：Tauri 启动包内的完整 `@bim-studio/api`，元数据写入 SQLite，大文件写入本地对象目录；项目、2D/3D、脚本、数据源、AI 和发布页面均使用正式 HTTP API；
- **连接服务器**：启动时或之后配置 HTTP(S) 地址，切换到团队服务器；页面、合同和请求路径不变；
- 生产前端始终从安装包内 `frontendDist` 加载，不加载远程页面；
- 单一可变服务器配置经过地址校验并持久化到应用配置目录；
- 本地 API 只监听随机回环端口，宿主为每次进程生成管理令牌；非回环请求与错误令牌均拒绝；
- 仅向主窗口开放服务器配置、凭据和本地 API 启动命令，无前端可用的 shell、任意文件系统或远程页面权限。

本地工作区固定在应用数据目录的 `workspace/`：`metadata.sqlite` 是权威元数据，`data/` 保存模型、附件、转换结果和发布产物，`logs/local-api.log` 保存本地服务日志。旧 IndexedDB 适配器只用于历史数据迁移和兼容测试，产品请求不再走该子集实现。现有 `.bimproject` 是本地与服务器双向迁移的唯一项目包格式；导入目标会重新分配身份，数据源凭据按既有安全规则不写入项目包。

当前桌面交付边界：完整本地 API、服务器配置安全校验、包内静态前端和 Windows NSIS/MSI 安装包。Native/Android 发布仍复用 API 的既有发布链和同一运行包，不在客户端复制打包器；正式发行必须同时提供相应的 Native 播放器、Android 模板与签名工具资源。安装包使用 per-machine 模式并内嵌 WebView2 离线安装器，首次安装和日常运行都不要求联网；代价是安装包约增加 127 MB。正式代码签名与自动更新仍需按发布环境接入。

```powershell
pnpm install
pnpm --filter @bim-studio/desktop build
pnpm --filter @bim-studio/desktop dev
```

`dev` 会启动同一套 `@bim-studio/web` Vite 前端；`bundle` 会先构建并部署完整 API sidecar、复制当前 Node 运行时、生产构建 Web，再生成桌面包。

```powershell
pnpm --filter @bim-studio/desktop bundle
pnpm --filter @bim-studio/desktop verify:bundle
```

安装包输出在 `src-tauri/target/release/bundle/nsis` 和 `src-tauri/target/release/bundle/msi`。

发布前至少执行桌面单元测试、正式打包和包体检查：

```powershell
pnpm --filter @bim-studio/desktop test
pnpm desktop:bundle
pnpm desktop:verify-bundle
```

MSI/NSIS 是 per-machine 包。真实安装、覆盖升级和卸载必须在具有管理员权限的干净 Windows 虚拟机中执行；在普通开发终端只完成管理镜像解包不能替代这项验收。

管理员生命周期门禁要求两个不同版本的 MSI，且会拒绝在已经安装产品的系统上运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-windows-install-lifecycle.ps1 `
  -BaselineMsiPath D:\release\Industrial-Studio-0.0.9.msi `
  -UpgradeMsiPath D:\release\Industrial-Studio-0.1.0.msi
```

门禁依次验证基线安装、包内程序启动、Major Upgrade、服务器配置保留、卸载登记清理和卸载后用户配置保留，并为每一步保存 MSI 日志及 `report.json`。

## 单场景只读客户端

只读客户端不是完整编辑器的改名包。它从指定发布版本固化场景与站内资源，使用专用 `SceneViewerRoot` 和只读 Tauri capability；交付目标与 WebGL/WebGPU 渲染模式分别配置。安装后只提供浏览和可选工具栏，不提供项目管理、二维/三维编辑、脚本、保存、发布、AI 或数据配置入口。作者行为脚本和实时数据不在该离线包中执行。

默认构建先把 viewer-only Web 产物写入 `.scene-viewer-build/<package-id>/web-dist`，再复制到同一包的 `frontend` 目录。该目录与普通 Web/编辑客户端的 `apps/web/dist` 隔离，发布器不会清理或覆盖后者。Vite 清单必须包含 `SceneViewerRoot` 且不能包含编辑器入口；复制后还会根据冻结快照裁剪不需要的导入器、物理运行时和公共资源。不能把普通 Web `dist` 直接当作只读包产物。

生产 API 模式必须提供精确发布时间，避免用户选择新版本后打包内容悄然变化。令牌建议只通过环境变量传入：

```powershell
$env:BIM_STUDIO_RELEASE_TOKEN = "<短期发布令牌>"
pnpm bundle:scene-viewer -- `
  --api-origin https://studio.example.com `
  --project-id project-1 --scene-id scene-1 `
  --published-at 2026-08-31T08:00:00.000Z `
  --token-env BIM_STUDIO_RELEASE_TOKEN `
  --renderer published --toolbar published
```

`--renderer` 支持 `published`、`webgl`、`webgpu-preferred`；`--toolbar` 支持 `published`、`show`、`hide`。构建完成后必须校验资源摘要、viewer-only 入口、只读 capability 和网络策略：

```powershell
pnpm verify:scene-viewer -- .scene-viewer-build/<package-id>
```

安装后浏览不依赖线上加载本项目资源。WebView2 使用内嵌离线安装器，目标机缺少 Runtime 时也不需要联网下载。
