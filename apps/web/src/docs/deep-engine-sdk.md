# Deep Engine 独立 SDK

面向在自己的网站、应用或播放器中使用 Deep Engine 的开发者。Web 渲染接口、应用宿主和插件生命周期从独立包导出；Native 嵌入 SDK 仍在建设中。

## 分层与模块

- 场景与资源合同：数据校验、实例、材质与运行包，入口为 `@bim-studio/deep-engine` 和 `/runtime-package`。
- 资源处理：glTF/GLB、几何、纹理与调度，入口为 `/gltf`、`/geometry`、`/textures`、`/streaming`。
- 渲染：WebGPU 设备、提交、光照、阴影与后处理，入口为 `/webgpu`、`/lighting`、`/shadows`、`/postprocess`。
- 宿主：Canvas、帧循环、输入与业务状态，由接入应用持有。

子路径均以 `@bim-studio/deep-engine` 为前缀。通过包的 exports 导入，不依赖 `src/` 私有路径。Studio 脚本中的 `studio.*` 是另一套宿主 API，不是独立渲染器入口。

## 获取与安装

当前包标记为 private，尚未发布到公共 npm。使用源码构建并生成本地归档，在外部项目安装归档：

```bash
# 在源码仓库根目录
pnpm install --frozen-lockfile
pnpm --filter @bim-studio/deep-engine build
pnpm --filter @bim-studio/deep-engine pack --pack-destination ../../artifacts

# 在自己的项目中，替换为归档的实际路径
npm install /path/to/bim-studio-deep-engine-0.1.0.tgz
```

TypeScript 宿主需要 WebGPU 类型时安装 `@webgpu/types` 并加入 tsconfig 的 types。使用支持 WebGPU 的浏览器，通过 HTTPS 或 localhost 访问。使用与分发遵循仓库 LICENSE；项目采用公开源码许可证。

## Web 接入流程

推荐使用 `DeepApp` 组合模块。宿主持有业务状态和 RAF；引擎负责插件依赖、逐帧调度和释放：

```ts
import { DeepApp, PbrRendererPlugin } from '@bim-studio/deep-engine/app';

const app = await DeepApp.create({
  state: { view },
  mode: 'always',
  plugins: [new PbrRendererPlugin({
    canvas,
    gpu: navigator.gpu,
    packet,
    view: frame => frame.state.view,
  })],
});

let running = true;
async function frame(timeMs: number) {
  if (!running) return;
  await app.advance(timeMs);
  if (app.shouldRequestFrame()) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

async function stop() {
  running = false;
  await app.dispose();
}
```

应用插件实现 `DeepAppPlugin`。通过 `dependencies` 声明依赖，通过 `provide` 暴露带类型的资源，通过 `addFrameStage` 加入帧阶段，通过 `onDispose` 登记清理。初始化失败会清理已经建立的资源；正常退出按插件和插件内部登记的相反顺序释放。

低层渲染接口也可单独使用：

以下为低层 API 调用顺序；`canvas`、模型字节 `modelBytes`、相机与视口配置 `view` 由宿主提供。

```ts
import { decodeGlb } from '@bim-studio/deep-engine/gltf';
import { PbrRenderer, type RenderView } from '@bim-studio/deep-engine/webgpu';

async function loadFrame(
  canvas: HTMLCanvasElement,
  modelBytes: Uint8Array,
  view: RenderView,
  signal: AbortSignal,
) {
  const packet = decodeGlb(modelBytes, { resourcePrefix: 'model-1' });
  const renderer = await PbrRenderer.create(canvas, navigator.gpu, signal);
  try {
    await renderer.setPacketValidated(packet, signal);
    await renderer.validateFrame(view);
    renderer.render(view);
    return renderer;
  } catch (error) {
    renderer.dispose();
    throw error;
  }
}
```

带纹理的 GLB 使用 `decodeTexturedGlb` 并注入图像解码器。这里的 `decodeGlb` 示例不代表完整纹理加载流程。

## 生命周期与配置

- 创建：`PbrRenderer.create` 的第四个参数为 `PbrRendererOptions`，可配置环境、阴影、资源预算和特性开关。未传参数使用现有默认值；并非所有高级特性默认开启。
- 加载：等待 `setPacketValidated` 成功，再显示新场景；捕获取消、资源校验与 GPU 创建错误。
- 更新：宿主驱动帧循环，调用 `render(view)`。变换变化使用 `updateInstances`，避免重复解码和上传完整几何。
- 视口：通过 `RenderView` 传入宽高、像素比、相机、背景和曝光等参数。宿主负责尺寸变化与输入映射。
- 退出：停止宿主帧循环和输入监听，再调用 `dispose()`；加载阶段的取消信号不能替代资源释放。

## 独立接入状态

统一应用入口、按需插件注册、依赖检查、宿主帧驱动、失败清理和逆序释放已经由 `@bim-studio/deep-engine/app` 提供。它复用现有帧循环和生产 WebGPU 渲染器，没有另建渲染内核。默认模块组、输入/GUI 插件、稳定的配置层和 Native 嵌入 API 仍需补齐。

GUI、输入和配置需要共享 Web/Native 合同；尚未完成一致性验收的控件和媒体能力不能视为跨端可用。Native 当前主要提供播放器与 Rust 内部模块，尚无承诺稳定的外部嵌入 ABI。

独立 SDK 已通过仓外消费门禁：从 `dist` 打包，在工作区外使用空缓存离线安装，完成 NodeNext/Bundler 类型解析、插件依赖与逆序释放、真实 Chrome WebGPU 两帧、相机与实例更新、取消和重复释放。浏览器执行只访问本地 fixture；生产 `present-color` GPU 读回验证实际像素，WebGPU validation 与 console/page error 为零。

接入方和引擎维护者可复跑：

```bash
pnpm gate:deep-engine-consumer
```

该门禁证明 Web SDK 可以脱离编辑器服务安装和运行。它不把当前模块列表外推为稳定的 Native 嵌入 ABI，也不代替真实项目资产、长稳和跨设备验收。

参见 [Deep Engine](deep-engine)、[Studio 应用 API](studio-api) 与 [SDK 可运行样例](sdk-examples)。

## 已提供的能力

下面按主题列出 SDK 当前已有、并带测试或真机证据的能力。证据文件的路径一并给出，方便复核。

### 显示默认值与渲染特性

`PbrRenderer` 的默认色调映射是与 Three r185 一致的 ACES（`three-aces-r185`），与 Studio 的显示合约同源；需要旧算子时显式传 `deep-aces`。产品里的曝光、色彩空间、环境强度、阴影滤波与泛光参数见 `packages/contracts/src/displayContract.ts`。独立接入时如果希望画面与 Studio 编辑器一致，从同一份合约取值，不要各自写死。

两端的像素级对比由 `pnpm gate:parity` 守护，结果见[渲染性能诊断](/docs/engine-performance)。

### 光照与全局光照

DDGI 探针 GI（Web）：`ProbeClipmapPbrController` 提供级联探针 GI，包含一跳场景辐射捕获（复用软件 TLAS→BLAS 的射线后端）、环境均值读回、能量钳制、受限的历史反馈，以及 Chebyshev 可见性和法线权重的漏光抑制。宿主通过渲染器启用：

```ts
renderer.setProbeClipmapEnabled(true); // radianceSource === 'scene' 表示真实场景捕获
```

关闭，或者没有真实辐射源时会回退到 IBL，不会发布一个全黑的体积。真机证据：`packages/deep-engine/test-output/probe-radiance-gpu-20260922/report.json`。

探针网格 GI（Native）：单层探针网格可以从 Web 一路打包到 Native 像素消费。

- 打包：`packNativeProbeGridRecords(level, probes)`（`deep-engine/lighting`）把原点、间距、网格尺寸和探针数组编码成 Native binding 11 使用的“网格头 + 96B 记录”。网格边长 2–64，总预算 65,535，越界一律拒绝；字节布局与 Rust 端 `probe_gi_grid` 的头解码逐字对拍。
- 发布：`compileSceneRuntimePackage` 接受可选的 `irradianceProbes`，原点转换到包坐标系后随环境载荷发布，证据标记为 `deep.scene.probe-grid.v1`；不传时不写字段，旧包的字节保持不变。
- 消费：Native 通过 `frame.lightDirection.w` 选择模式，0 为关闭，1 为最近探针，不小于 1.5 为网格三线性 8 点采样。头部、记录数或世界位置任一非法都返回零。真机证据见 `packages/deep-engine-native/test-output/` 下的 `f2-rt-raster-parity-*`。
- 边界：多层 clipmap 级联和 GPU 烘焙编排（捕获、读回、聚合）尚未接线。

静态光照描述符：运行包的环境合同提供 `RuntimeStaticLightmapDescriptor`（`deep-engine.static-lightmap` v1），描述纹理 id、SHA-256、UV 集、色彩空间、强度和尺寸。构建期会校验纹理是否存在、occlusion / emissive 语义、尺寸是否匹配、哈希是否一致、几何里是否有对应的 UV 集，任一不满足即构建失败。

### 粒子

GPU 粒子：`GpuParticleRuntime` 与 `PbrParticlePass` 提供全 GPU 的粒子模拟和 billboard 渲染，内置警报脉冲、扩散环、流线三种预设，支持爆发事件和 indirect 绘制（CPU 不回读数量），已经接入产品的 PBR 帧循环，按真实帧间隔驱动（单步上限 250 ms）。真机证据：`packages/deep-engine/test-output/gpu-particle-render-20260923/report.json`。

CPU 侧基线通过 `@bim-studio/deep-engine/particles` 暴露：

- 曲线：`createParticleCurve` 创建关键帧曲线，`bakeParticleCurveLut` 烘焙成 64 点查找表，`sampleParticleCurveLut` 以 O(1) 采样。
- 预算：`planParticleBudget` 按最大余数法分配多个发射器的预算，并在超限时分级降级。
- 排序：`sortParticlesBackToFront` 做透明粒子由远到近的计数排序，时间 O(n)、稳定且确定，误差不超过距离范围除以桶数。

编辑器的“火焰图层”已经使用这三项，用法见[三维效果、环境与物理光照出图](/docs/scene-effects-rendering#火焰图层)。GPU 路径的排序核、曲线 LUT 纹理采样和烟体接线还没有完成。

### 几何与调度

Cluster LOD 间接执行：`ClusterLodIndirectExecutor` 把已有的 cluster 选择和 indirect 计划接到 WebGPU，包括 GPU 命令上传、驻留几何校验、render bundle 缓存和 `drawIndexedIndirect`。真机像素对拍证据：`packages/deep-engine/test-output/cluster-lod-gpu-20260920-r1/evidence.json`。

场景动画播放区间：编辑器时间轴的入点和出点（`SceneAnimationState.playbackRange`）发布时会转成 `dynamic-animation.playbackRangeMs`，合同要求 0 ≤ 入点 < 出点 ≤ 时长。Native 的 `sample_animation` 和发布查看器的采样都会钳制在区间内；没有设置区间时播放整条时间线。

### 物理

`@bim-studio/deep-engine/physics` 提供 `FixedStepClock`：按固定频率累计时间并量化成整数步，余量结转到下一帧，追赶步数有上限，超出的部分计入 `droppedTicks`。Studio 的物理宿主用它以 60 Hz 推进 Rapier，因此同一初始状态在不同帧率、不同抖动下，同一个 tick 的轨迹逐位相同。接入时请把宿主的帧间隔交给时钟，不要自己写累加器。

碰撞体调试视图：`ViewerEngineSimulation.collectPhysicsDebugColliders()` 返回所有已登记 Cuboid 碰撞体的世界位姿、半尺寸和局部偏移，渲染层的 `createPhysicsDebugOverlay()` 按刚体类型用四种颜色画线框，物理面板里有“显示碰撞体”开关。真实画面里的视觉表现还没有在带渲染器的环境中验证。

### 体积雾

Deep WebGPU 使用半分辨率的 march 加 HDR 合成，介质参数包括基础消光、高度尺度、各向异性和散射反照率（`albedo`，默认 0.82）。体积雾默认关闭，关闭时不创建 pass。引擎不提供 RGB 雾色，散射颜色由主光的辐亮度决定。

### 着色器作者图

`@bim-studio/deep-engine` 公开 WGSL 优先的作者图合同：`ShaderGraphAssetV1`、节点注册表、规范序列化与哈希、校验、到既有 WGSL 编译器 IR 的确定性降级、编辑器诊断的 MessageStore、预览准备合同，以及 SubGraph 依赖清单。可视化编辑器还在开发中，目前合同由降级测试和 shader 套件覆盖。

### 独立消费示例

在工作区外的空目录里离线消费 SDK 的完整链路已经验证。`packages/deep-engine/examples/node-standalone.mjs` 做运行包校验和探针网格打包，`examples/browser-standalone.mjs` 用 ESM bundle 加无头 Chrome 做断言。整条链路由下面的命令驱动：

```bash
node packages/deep-engine/scripts/standaloneConsumerExamples.mjs
```

它会重建 dist，打包两个 tarball，在断网探针下用 npm 离线安装，运行 Node 示例，再用浏览器示例截图。样例证据在 `test-output/f6-standalone-20260923/`。