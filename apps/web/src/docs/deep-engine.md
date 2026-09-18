# Deep Engine

Deep Engine 是 Studio 的 WebGPU 渲染内核，另有 Windows 原生 wgpu 执行器。编辑器继续保留 Three.js WebGL 作为作者基线；两者共享项目状态。

![Deep Engine 架构：作者状态、WebGPU、Native 与发布门](docs-assets/deep-engine-architecture.svg)

## 切换渲染器

三维编辑器 → 更多 → 渲染诊断：

- **WebGL 2**：Three.js 作者画布。
- **Deep WebGPU**：投影同一场景状态，验证首帧后接管画布。

Deep 路径包含模型、相机、环境、灯光、阴影、LOD，以及选择、测量、标注、剖切和 BIM 放置辅助层。设备或管线失败时自动回到 WebGL，并保留编辑状态。

## 运行测试

```bash
pnpm install --frozen-lockfile
pnpm studio start client
pnpm gate:deep-engine-editor
```

需要真实 WebGPU 时：

```bash
pnpm gate:webgpu
pnpm --filter @bim-studio/web benchmark:render-engines
pnpm --filter @bim-studio/deep-engine lab:serve
```

Lab 地址为 `/benchmark`。报告写入 `test-output/`。性能比较必须固定设备、资产、轨迹、分辨率和画质。

## 构建 Windows 编辑客户端

```bash
pnpm verify:release
pnpm desktop:bundle
pnpm desktop:verify-bundle
```

安装器输出在 `apps/desktop/src-tauri/target/release/bundle/`。完整客户端包含编辑、脚本、数据和发布功能。

## 从发布页打包客户端

发布对话框的“客户端打包”提供三个目标：

- **仅发布**：只生成网页发布版本。
- **Three WebView**：下载现有 Three.js/WebView 交付包素材。
- **Deep Native**：下载 Deep Engine 原生 wgpu 交付包素材。

编辑器始终运行在 WebView。Deep Native 只改变发布物的运行时目标，不会把编辑器改成原生窗口。当前页面下载可审计的 `.bimscene.zip` 交付包，包含二维应用、三维场景、资源、绑定和脱敏后的数据运行时；Windows EXE 仍由对应客户端构建器生成。

HTTP、PostgreSQL 等外部连接不会把密码、令牌或请求头写入包。发布包保留连接类型、数据集、流水线和绑定；部署到客户端时需在运行环境重新配置凭据。`sim:` 仿真连接可直接随包运行。

## 构建只读场景客户端

先发布场景，再生成冻结包：

```powershell
pnpm --filter @bim-studio/desktop bundle:scene-viewer -- `
  --api-origin http://127.0.0.1:4100 `
  --publication-id <PUBLICATION_ID> `
  --token-env BIM_STUDIO_PACKAGE_TOKEN `
  --renderer webgpu-preferred
pnpm --filter @bim-studio/desktop verify:scene-viewer -- .scene-viewer-build/<PACKAGE_ID>
```

Three WebView 只读包不包含项目管理、编辑、保存、脚本和 AI。页面下载的 `.bimscene.zip` 会保留脱敏后的数据连接描述、数据集、流水线和场景绑定；外部连接凭据必须在客户端运行环境配置。

## Native 便携包

`artifacts/windows-portable/deep-engine-native-0.1.0-x86_64-pc-windows-msvc` 提供 `Run-Viewer.cmd`、`Run-LOD.cmd` 和 `Run-Shaders.cmd`。该包用于验证原生 wgpu、GPU LOD、间接绘制、CSM、Deep2D 与设备恢复。

## 证据边界

- 浏览器 WebGPU、Native wgpu 和 Unity 6 D3D11 均有本机证据。
- Unity Vulkan 等价基准仍受 shader 构建模块阻塞。
- 百万点报告中的 host wall time 不是 GPU timestamp。
- “Unity ≥90%”只接受同资产、同轨迹、同画质的复现实测。
