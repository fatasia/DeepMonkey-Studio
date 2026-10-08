# Deep Engine

Deep Engine 是 Studio 自研的渲染内核，包括 WebGPU 和 WASM 两条浏览器路径，以及 Windows 原生的 wgpu 执行器。编辑器里始终保留 Three.js（WebGL）作为作者基线，几条路径共用同一份项目状态和同一份显示合约，在它们之间切换不会改动你的场景。

![Deep Engine 架构：作者状态、WebGPU、Native 与发布门](docs-assets/deep-engine-architecture.svg)

## 切换渲染器

在三维编辑器里点“更多”，选“渲染引擎”，打开“渲染引擎设置”面板。面板先检测浏览器、显卡和项目能力，然后给出三个目标：

- 兼容模式：Three.js 的 WebGL 2 作者画布，任何环境都可用。
- Deep WebGPU（默认渲染引擎）：把同一份场景状态投影到 WebGPU 管线，验证首帧成功后接管画布；设备不支持 WebGPU 时自动回落 WebGL。
- Deep WASM：同样使用 Deep 管线，走 WASM 实现。

切换前会先做预检，激活成功才保存你的偏好；设备或管线失败时自动保留 WebGL，作者数据保持在同一个工作区里，不丢编辑状态。面板里还有“重新检测”“导出诊断”（导出设备、后端和性能证据）、“实时性能”和“帧图回执”，排查画质或性能问题时先看这里。播放模式暂不支持 WebGPU，要播放请先切回 WebGL。

Deep 路径覆盖模型、相机、环境、灯光、阴影、LOD，以及选择、测量、标注、剖切和 BIM 放置这些辅助层。两条路径的画质与功能是否等价，要逐个场景验收，面板里的“渲染能力清单”会列出哪些项受限。

## 与 Three.js 的显示一致性

作者画布和 Deep 如果各用各的默认值，同一个场景在两边看起来就会不一样。为此，色调映射、曝光、输出色彩空间、环境强度、阴影滤波与偏移、抗锯齿和泛光参数集中在一份显示合约里（`packages/contracts/src/displayContract.ts`），Three 主视图、Deep WebGPU 的产品桥和发布编译都从这一份读取。Deep 引擎的默认色调映射因此改为与 Three r185 一致的 ACES 算子，原来的 `deep-aces` 仍可显式选用。

合约保证的是默认值同源，不等于每个像素都一样。真实的两端画面对拍由一致性门负责：

```bash
pnpm gate:parity
```

它在真实 GPU 上让 Three 与 Deep 渲染同一组标准场景，逐场景比较并分档。运行大约 3 分钟，没有可用的 WebGPU 硬件适配器、只有软件回退，或出现 GPU 校验错误时会直接失败，不会悄悄通过。已知的差距主要有两类：边缘抗锯齿算法不同，以及 IBL 预滤波的采样核不同；半透明叠加已经落在容许范围内。扩展 PBR 材质瓣（透射、sheen、虹彩等）还没有进入对拍。详细结果见[渲染性能诊断](/docs/engine-performance)。

## 运行测试

```bash
pnpm install --frozen-lockfile
pnpm studio start client
pnpm gate:deep-engine-editor
```

需要真实 WebGPU 时：

```bash
pnpm gate:webgpu
pnpm gate:parity
pnpm --filter @bim-studio/web benchmark:render-engines
pnpm --filter @bim-studio/deep-engine lab:serve
```

Lab 的地址是 `/benchmark`，各项报告写入 `test-output/`。比较性能时必须固定设备、资产、相机轨迹、分辨率和画质。

## 构建 Windows 编辑客户端

```bash
pnpm verify:release
pnpm desktop:bundle
pnpm desktop:verify-bundle
```

安装器输出在 `apps/desktop/src-tauri/target/release/bundle/`。完整客户端包含编辑、脚本、数据和发布功能。

## 从发布页下载场景客户端

发布对话框的“发布方式”有三项：

- 仅发布：只生成网页发布版本。
- Three WebView：发布后下载以 Three.js 渲染的独立 Windows EXE。
- Deep Native：服务端编译并验证 Native 窗口，通过后下载 Deep Native 的 Windows EXE。

编辑器本身始终运行在 WebView 里，Deep Native 改变的只是发布物的运行时目标，不会把编辑器变成原生窗口。操作步骤、权限和启动器配置见[预览、体检与发布](/docs/server-publish#下载单场景-windows-客户端)。

外部连接（HTTP、PostgreSQL 等）的密码、令牌和请求头不会写进发布包，包里只保留连接类型、数据集、流水线和绑定，部署到现场后要在运行环境里重新配置凭据。`sim:` 仿真连接可以直接随包运行。

## 构建只读场景客户端

运维人员也可以不经过页面，用命令从一个已发布版本生成冻结包：

```powershell
pnpm --filter @bim-studio/desktop bundle:scene-viewer -- `
  --api-origin http://127.0.0.1:4100 `
  --publication-id <PUBLICATION_ID> `
  --token-env BIM_STUDIO_PACKAGE_TOKEN `
  --renderer webgpu-preferred
pnpm --filter @bim-studio/desktop verify:scene-viewer -- .scene-viewer-build/<PACKAGE_ID>
```

只读包不含项目管理、编辑、保存、脚本和 AI。校验通过说明资源摘要、只读入口和能力集合符合预期，不代替在干净 Windows 机器上的安装验收。

## Native 便携包

Native 便携包用来验证原生 wgpu、GPU LOD、间接绘制、CSM、Deep 2D 和设备恢复，由下面的脚本生成：

```powershell
packages/deep-engine-native/scripts/package-windows-portable.ps1
```

默认输出在 `packages/deep-engine-native/artifacts/windows-portable/`（本地生成，不随仓库提交），目录里有 `Run-Viewer.cmd`、`Run-LOD.cmd` 和 `Run-Shaders.cmd` 三个启动脚本。

## 证据边界

- 浏览器 WebGPU、Native wgpu 和 Unity 6 D3D11 都有本机实测证据。
- Unity Vulkan 的等价基准仍受 shader 构建模块限制，没有结论。
- 百万点报告里的 host wall time 不是 GPU timestamp，不能当 GPU 耗时引用。
- “Unity ≥90%”只接受同资产、同轨迹、同画质的复现实测。