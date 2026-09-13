# Deep Engine：通用网格与 GLB 增量

日期：2026-09-12。状态：通用网格、嵌入纹理、法线/AO/emissive、透明/双面与 GPU 事务增量已复验；动画、完整光照和产品接入继续推进。承接 [执行方案](deep-engine-execution-plan-2026-09-12.md) 与 [S1 材质管线证据](deep-engine-webgpu-verification-2026-09-12.md)。不改变完整目标。

## 范围与实现

- 独立 `packages/deep-engine`。正式 apps、默认 Three、设置、作者数据/脚本、账号和存储未由本批修改；未提交和 push。
- 修复实验页从包外深引用 `src` 的架构回归：使用公开 `./webgpu` / `./gltf` 入口，构建使用 development 条件；`lab:isolation` 现在同时运行原 Web 架构测试，不修改或削弱该测试。
- `RenderPacket` 是作者状态的渲染投影：共享几何、独立 PBR factor/五类纹理/alpha/双面材质、实例仿射矩阵、稳定 ID 与几何版本。当前仍是静态三角网格子集，不宣称完整引擎格式。
- 镜像实例按绕序分批并共享绑定布局；法线用逆转置矩阵，顶点与片元均归一化，修复非均匀缩放下的插值偏差。
- 完整加载先准备候选资源，再等待 validation/out-of-memory/internal 错误作用域，成功后发布；失败、取消、后发替换和销毁释放候选，保留旧包。
- 几何全量更新严格扫描/复制/检查版本；实例增量更新只处理实例与材质，保留几何。隐藏全部实例与释放所有几何是两个明确的生命周期操作。
- `decodeGltf` / `decodeGlb` 不执行 IO。静态、不透明、POSITION/NORMAL 三角网格、8/16/32 位无符号索引与无索引、合法 stride/offset、材质 factor、场景/node matrix/TRS；其余未支持语义显式失败，不静默丢弃。
- `decodeTexturedGlb` 在相同静态子集上加入 TEXCOORD_0、嵌入 PNG/JPEG、sampler、baseColor / metallic-roughness 纹理及 `KHR_texture_transform`。图片解码器由宿主注入，取消会立即终止外层请求；同一图片只解码一次，再按颜色语义生成独立所有权副本。
- WebGPU 资源事务共同准备并发布几何、实例、材质和纹理。baseColor 按 sRGB、metallic-roughness 按线性数据上传，WGSL 读取 MR 的 B/G 通道；无纹理材质走独立 pipeline，不为禁用贴图额外执行两次纹理采样。

## 样本与真实验证

Cesium Box / BoxInterleaved / BoxTextured 原始 GLB，CC BY 4.0。固定 Khronos Sample Assets 提交 `90d7ede14c7e280af263824604b427a1ca02cb66`，精确来源、SHA-256、字节数、许可与结构检查见 [sources.json](../../packages/deep-engine/lab/assets/sources.json)。BoxTextured 为 5,956 bytes，SHA-256 `b510eca2e2ef33f62f9ed57d6e7ce2d10ebb2bdebc4a8e59d347719ba81abdf4`，包含 256×256 PNG、UV0 和 baseColorTexture。展示时仅做统一缩放、落地和实例排列，不修改源材质和文件。

本地实验页保留材质球、混合网格、两种 GLB、设备丢失/重建；新增真实 GPU 错误注入回滚。注入使用非法 buffer usage 触发验证错误，不通过申请大量显存制造 OOM。真实 OOM 和内部设备错误目前只在事务测试中模拟，不能将其当驱动故障实证。

### 动态实例 CPU 优化

同一 NVIDIA Lovelace 适配器、954×660 实际画布、混合网格、1,024 个运动实例、14 个含阴影 draw calls：优化前构建 `902ff6bf…` 的 120 帧 CPU 实例准备 P95 为 8.90 ms；优化后构建 `da8eea87…` 两次各 120 帧为 0.70 / 0.80 ms，下降约 91%–92%。CPU 提交 P95 从 0.40 ms 降为两轮 0.20 ms。原始记录：[优化前](../../test-output/deep-engine/webgpu-1789201250694.json)、[优化后](../../test-output/deep-engine/webgpu-1789202044739.json)。

GPU P95 在优化前为 0.52 ms、优化后两轮为 0.39 / 0.98 ms，表明本批改的是 CPU 投影分配热点，不能据此宣称 GPU 已优化或整体领先竞品。CPU-only 交替微基准另见 [优化前](../../test-output/deep-engine/packet-pack-before-20260912.json) 与 [优化后](../../test-output/deep-engine/packet-pack-after-20260912.json)；128 小几何 P95 有噪声回退，仍需正式固定负载多轮基准。

### 嵌入纹理真实浏览器证据

构建 `f9abd32fab367d81bb319f01bd0a57a39b296011b96866d53404647d09a183f7` 的 JS 为 102,185 bytes、gzip 33,098 bytes。BoxTextured 已在 Chrome/WebGPU 实际显示；49 实例加载、GPU 错误注入回滚、`device.destroy()` 后资源归零并重建纹理首帧均通过，控制台和设备错误为空。记录见 [webgpu-1789204519285.json](../../test-output/deep-engine/webgpu-1789204519285.json)。

同一记录的 1,024 纹理实例、120 个有效 GPU 样本：CPU submit P50/P95 为 0.2/0.5 ms，GPU P50/P95 为 1.835/4.456 ms，每帧 3 次缓存 draw。页面当时处于后台节流，RAF 间隔约 1,007 ms，不能用于 FPS 或流畅度结论；该结果也没有竞品同画面对照。

核心与实验页 typecheck、26 个 Vitest 文件 334 项测试、5 项 AST 测试、build 与 lab build 均通过。深色宽屏与 480×980 浅色已进行两轮实际视觉复验，窄屏无横向溢出；纹理提升了真实资产覆盖，法线、透明和复杂模型仍未达到完整视觉门禁。

## 后续完整目标

更多真实模型、动画/骨骼、灯光和完整画质、GPU 剔除、作者提取与同脚本宿主、真实项目一键切换、原生和工具链继续为本轮待办或项目级后验收。法线/TBN、AO/emissive、透明与双面已完成当前静态子集验证，但不代表高级材质或完整场景画质。默认视觉/性能以 Unity/UE5 为目标，Three/Babylon 领先与三大引擎各自 90% 没有达标声明。

视觉沿用 `design-taste-digitaltwin`：Unity PBR/HDR、山海鲸场景氛围、西门子克制信息，UI 令牌来自 `apps/web/src/styles/base.css`。当前静态材质子集已加入真实贴图、normal/AO/emissive、alpha、双面、HDR/4×MSAA/ACES 和单方向光 PCF 阴影，但复杂灯光、IBL/Bloom/雾、真实大场景和冻结竞品像素对照仍缺失，因此不宣称完整 Kimi-95 或 Unity/UE5 视觉达标。

## 原生 wgpu 纹理 PBR 纵向切片

`packages/deep-engine-native` 已把同一 RenderPacket v1 方向推进到真正的原生 GPU 路径：UV0、切线、baseColor、metallic-roughness、normal、AO、emissive、完整 authored mip、sampler 和 UV 仿射变换均有严格合同；baseColor/emissive 使用 sRGB 格式，其余数据纹理使用 linear 格式。五类槽位固定为 11-binding 材质布局，未启用槽位使用颜色空间正确的 1×1 fallback，再由 uniform 跳过采样，避免按纹理组合生成管线笛卡尔积。

根级独立复验通过：Rust 49/49、`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`；依赖门禁解析 85 个 Windows 运行时包，未发现 WebView、Chromium、browser 或 GL fallback。RTX 4060 Laptop / Vulkan / `Bgra8UnormSrgb` 实机在同一 encoder 上完成纹理 3D 后接 Deep2D 并 present：5 个 authored + 5 个 fallback texture、10 个 mip level、1 个材质 bind group、2 个源三角形×2 实例、Deep2D 387 vertices。原 13-triangle 无纹理路径和空场景路径也保持通过。

Windows release EXE 为 7,112,704 bytes，SHA-256 `bafdbd81dd2502235e094a1c1182b0b7100df730a94fcb23e5cc0337dd3c366e`；debug EXE 为 16,439,296 bytes，SHA-256 `8cde7c3884ed5f3760aefc0008b1857462419e1c8a9b8f9b3341a70e64c8837b`。确定性五纹理 fixture 为 3,308 bytes，SHA-256 `6a774ab80e55494d98412e7017ad008cb2c92210705728d76281d5c5e352dd3f`。

原生切片仍明确拒绝 alpha MASK/BLEND 和 double-sided；也未包含压缩纹理、自动 mip、HDR/EXR、阴影、IBL、HDR render target、流式与跨帧纹理缓存。浏览器管线已经支持这些材质模式中的一部分，不能反向写成原生已经支持。Metal 已加入 backend 请求集合，但当前没有 macOS 真机证据；Linux Vulkan 同样待 runner 验证。

## 原生 alpha、透明排序与双面增量（覆盖上一节旧边界）

RenderPacket v1 原生路径现已支持 `OPAQUE`、factor×baseColor texture alpha 的 `MASK`、straight-alpha source-over `BLEND` 和 `doubleSided`。透明对象进入独立 pass、关闭 depth write，并按当前相机/yaw 对对象 AABB 中心做稳定的全局远到近排序；双面通过 no-cull、`front_facing` 与实例 determinant sign 修正 normal/TBN。固定 11-binding 材质布局不增加纹理组合变体，当前总计 6 个 pipeline variant。

对抗审查修复了两个真实缺陷：透明排序包围盒现在只遍历索引实际引用的顶点，避免未绘制顶点拖偏顺序，并用不溢出的中点公式处理合法大 `f32`；GPU loss/uncaptured-error 回调携带 renderer 世代 ID，旧 renderer 的延迟事件不会污染重建后的实例。确定性 alpha fixture 为 9,453 bytes，SHA-256 `99acee28b07d5a6ab0b472bda9ea21350547da6a7ccc056377030aabae651cdb`。

最终根级复验为 Rust 79/79、fmt、clippy `-D warnings`。RTX 4060 Laptop / Vulkan / `Bgra8UnormSrgb` 实机执行 textured、alpha、textured+Deep2D 和 shadow 四个 release smoke，均完成 64×64 present 且无 validation/device lost。alpha 为 1/1/2 opaque/mask/blend batch、2 个 double-sided batch、12 个 forward 与 9 个 shadow pipeline variant；Deep2D 为 3 commands、72 path segments、7 fill triangles、122 stroke triangles、387 vertices。shadow 的 `rgba16float` 读回有 118 个像素变化，shadow-on 总线性亮度 1079.459051，all-lit 为 1123.242496。release EXE 为 7,227,392 bytes，SHA-256 `edc4a4d36c7f883a46b16f9ec24ff7473aa468f7fa62a8fc0e0fbe9c6515e509`。

这仍不是完整透明方案：互相穿插的大型透明网格需要 OIT、分簇或几何级排序；双面透明目前单 pass；阴影、IBL、HDR、压缩纹理、自动 mip、流式/跨帧缓存和像素级画质对照仍待完成。上一节“明确拒绝 alpha/double-sided”的描述只记录此前批次，已被本节覆盖。
