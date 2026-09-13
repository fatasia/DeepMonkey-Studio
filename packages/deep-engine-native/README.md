# Deep Engine Native Viewer

这是 Deep Engine 的独立原生 Viewer 起步实现，不是 WebView/Tauri/Chromium 壳，也没有接入正式 `apps/desktop`。它直接使用 Rust `winit 0.30.13 + wgpu 30.0.1` 创建 Windows 系统窗口、DX12/Vulkan adapter、device 和 surface，并执行版本化 RenderPacket JSON。当前实机验收覆盖 Windows Vulkan；macOS、Linux 与移动端已移出当前交付范围。

当前已具备：静态几何/材质/实例的索引绘制与深度缓冲；按几何、材质和镜像绕序建立稳定批次；同一不透明批次单次 instanced draw；非均匀缩放的逆转置法线矩阵；正/镜像背面剔除与 double-sided no-cull；空场景 clear/present；以及同一 device/queue/surface/view 上的原生 Deep2d 透明后置 pass。RenderPacket v1 的第一批真实纹理 PBR 已支持 baseColor 与 emissive 的 sRGB 采样、metallic-roughness/normal/occlusion 的线性采样、完整 authored mip、采样器、每槽 UV0/UV1 选择、KHR 风格 UV 仿射变换、TBN 法线、AO strength、IBL、emissive 在线性光照后和 ACES 前叠加。GPU compute 剔除与 LOD 选择会压实实例并驱动主视图和各级阴影的 indirect draw；2–4 级 CSM 提供稳定分割、texel snapping、级联混合和 3×3 PCF。原生 HDR Bloom 默认启用，在线性色彩空间按 threshold/soft-knee 预过滤，使用半分辨率双向高斯模糊，并在 ACES 前按 intensity 合成；`--no-bloom` 保留单次 ACES 输出路径，不创建 Bloom pipeline、纹理或额外 pass。版本化 Shader Package 能与内建材质共用真实 Frame、IBL、纹理、LOD 和 CSM 场景资源。MASK 使用 factor×纹理 alpha cutoff；BLEND 进入独立 pass，关闭深度写入，以实例为批次按相机全局稳定后向前排序并使用 straight-alpha source-over。GPU shader/pipeline/texture/sampler/material bind group、frame、depth 与 Bloom 资源在 error scope 中整批构建，失败时不会发布候选资源；手动 R 重建失败会保留旧 renderer。resize/缩放恢复只重建尺寸相关的 HDR/Bloom 纹理和绑定，设备级 pipeline 不会逐帧或随 resize 重建。

RenderPacket GPU 场景现已通过 device-epoch cache 构建：geometry/texture 以 `id + revision + SHA-256 内容身份` 管理，同一 revision 更改内容会失败关闭；材质身份覆盖 uniform 与纹理依赖，实例和批次独立计算 SHA-256。候选场景只在全部 wgpu error scope 通过后发布，旧场景继续持有 `Arc` 资源，缓存只保留 `Weak` 引用。相同 packet 可复用 geometry/texture/material/instance；单个实例变化会创建候选缓冲，在 GPU 复制未变的 144B 行，仅从 CPU 上传变化行。设备重建创建新 epoch，旧候选不能提交。`Renderer::replace_render_packet` 已形成真实事务接点并会重建依赖实例数据的 culling/LOD，同时递增 shadow scene version；文件监控/网络热重载入口尚未接线。该同步边界没有中途取消 token，调用方只能在进入前取消。

Shader Package 的原生磁盘 CAS 只在调用 `ShaderDiskCache::open` 或 `rebuild` 时访问文件系统。cache scope 严格包含 namespace、package schema、target profile、compiler version、shader ABI ID 与 ABI hash；record 另校验 package cache key、规范化 package SHA-256 和完整 v2 合同，不存储 `wgpu` handle。每个目录由 cache 实例生命周期内的系统文件锁排他持有，第二进程或第二实例会收到 `cache-busy`。record 与 index 先 `sync_all` 临时文件，再用同目录不可变文件名的原子 no-clobber hard-link 发布（Windows 也不覆盖既有目标）；活动 generation 始终保留上一代完整可达快照，启动时可从损坏或中断写入回退，而显式未知 schema、scope 不匹配和重复 generation 会失败关闭。`get` 只在内存中更新 LRU 次序，不重写或扫描 index；下一次 mutation 或显式 `flush` 才持久化次序。活动快照按 `max_entries`/`max_bytes` 确定性淘汰，上一代快照只用于崩溃恢复；取消只在发布提交点前生效，权限、磁盘满、容量、损坏和锁冲突都有稳定错误码。`rebuild` 只删除该 CAS 自有的 index、record 和中断临时文件，保留同目录的其他文件。

CSM 会从实际索引引用的 geometry（包括 LOD level）计算局部 AABB，再用实例仿射矩阵的绝对线性部分得到保守 world AABB，因而覆盖非均匀缩放、剪切和镜像。场景 bounds 会收紧接收者的 cascade 距离，并扩展每级光空间深度以容纳 caster；空场景保留稳定的默认计划。为避免 float32 精度失控，原生拟合显式拒绝绝对坐标超过 1,000,000 或单轴跨度超过 100,000 的场景，此类数据需要先应用 floating origin。packet 更新先构建 CPU shadow 候选，并以候选矩阵创建 culling/LOD；只有场景 cache 和全部 GPU error scope 成功后才写入活动 shadow uniform，失败不会改变旧 scene/shadow。相同 resize 和相同 view yaw 是无操作，普通帧只在 `{scene, light, shader}` 版本变化时重绘 shadow map。

```powershell
cargo run --locked -- --headless-contract
cargo run --locked -- --headless-pbr
cargo run --locked -- --headless-alpha
cargo run --locked -- --headless-deep2d
cargo run --locked -- --smoke-frame
cargo run --locked -- --smoke-no-bloom
cargo run --locked -- --smoke-textured
cargo run --locked -- --smoke-textured-deep2d
cargo run --locked -- --smoke-alpha-deep2d
cargo run --locked -- --smoke-shadow
cargo run --locked -- --smoke-shadow-update
cargo run --locked --release -- --smoke-shader-package
cargo run --locked -- --smoke-deep2d
cargo run --locked
cargo run --locked -- --packet fixtures/render_packet_v1.json
cargo run --locked -- --no-bloom fixtures/render_packet_v1.json
cargo test --locked --test bloom_gpu -- --ignored --nocapture
cargo test --locked --bin deep-engine-native nvidia_scene_fitted_shadow_update_is_transactional -- --ignored --nocapture
cargo run --locked -- --packet-with-deep2d fixtures/render_packet_v1.json fixtures/deep2d_path_only_v1.json
./scripts/verify-dependencies.ps1
./scripts/build-windows.ps1 -Profile all -SmokeFrame
```

`build-windows.ps1` 运行依赖门禁和测试，生成 debug/release Windows 二进制，并把路径、字节数和 SHA-256 写入忽略提交的 `artifacts/native-build-manifest.json`。

`--smoke-frame` 创建位于桌面外的 64×64 原生窗口和真实 surface，完成一次 GPU 提交与 present 后自动退出；`--smoke-deep2d` 在同一 encoder 中先绘制 3D，再以 load-op 后置 pass 绘制 Deep2d，并在真实 present 后退出。Windows 对真正 hidden 的 swapchain 会返回 occluded，因此这里保留 compositor-visible 状态但不遮挡桌面。10 秒内未 present、device lost 或未捕获 GPU 错误都会返回非零。这些命令是自动化首帧门禁，不代替可见窗口的画面审查。

`bloom_gpu` ignored probe 直接在真实 NVIDIA adapter 上写入一张含超阈值亮区和隔离低亮区的 `rgba16float` 图像，执行生产 Bloom pass 与 ACES 合成 pipeline 后读回半分辨率 Bloom。它要求亮区扩散到邻近像素、隔离暗区保持零 Bloom 能量，并检查 validation/out-of-memory/internal scope 与 uncaptured GPU error 均为空。

`--smoke-shader-package` 严格解析 `deep-shader-package` v2，创建 WGSL module、bind-group layout、pipeline layout 和 forward/shadow render pipeline，并在 Vulkan 上执行 4× `rgba16float` resolve 与 `depth32float` shadow readback。探针绑定的是按冻结 ABI 创建的确定性探针资源，用于验证布局与 GPU 执行；它不会把这些资源冒充现有 RenderPacket 场景资源。package executor 拥有 pipeline 和 bind-group layout，renderer 必须用 executable pass 暴露的同一 layout handle，为真实 Frame、shadow、IBL、材质、geometry/instance 创建 bind group 并负责 attachment、draw 和提交。当前原生场景 renderer 仍使用自己的固定 pipeline/layout，因此正式接入还需要共享 GPU 资源注册表或重建对应 bind group，不能直接复用另一个 layout 创建的 bind group。

## 合同与 WGSL 边界

合同标识为 `deep-engine.render-packet` v1，字段与 `packages/deep-engine` 当前 Geometry/Material/Instance/Texture 资源方向对齐；`--headless-contract` 执行大小、唯一 ID、几何/UV/切线布局、索引、有限数、仿射变换、资源引用、颜色空间语义、完整 mip、采样器和纹理预算验证。渲染计划保持几何的 `(id, revision)` 和材质 ID 的包内顺序，批次按首次出现顺序稳定生成；device 重建会得到同一映射。`fixtures/render_packet_textured_v1.json` 是仓内确定性 RGBA8 五纹理样本，覆盖两个 sRGB 和三个线性纹理、10 个 mip level、UV transform、TBN、镜像实例与一个材质 bind group。`fixtures/render_packet_empty_v1.json` 用于验证空场景路径。

浏览器的 `pbrShader.ts` 仍依赖 IBL，不能直接拷贝成原生着色器。本包使用版本化 `assets/shaders/native_mesh_v1.wgsl`；Native ABI-1 已对齐 `deep.pbr.mesh.v1` 的 40 字节 geometry 流、独立 16 字节 tangent 流、144 字节 compact instance、160 字节材质块、UV1 位置和每槽选择编码。固定 11 个 binding 的材质布局承载五种 glTF core 纹理；未启用槽位使用颜色空间正确的 1×1 哑纹理，同时由 uniform 标志跳过采样，避免纹理组合制造 pipeline 笛卡尔积。opaque/MASK/BLEND × regular/mirrored/double-sided × standard/normal-mapped 固定为 12 个 forward pipeline；普通材质不创建或绑定 tangent GPU 流。MASK 和 opaque 共用写深度路径，BLEND 单独读深度但不写入。Native ABI-2 已将 Frame 对齐到 `deep.pbr.mesh.v1` 的 208 字节 view/light/eye/background/floor/lightDirection/tuning 布局，并把 forward 渲染迁到 `rgba16float`、4× MSAA、required resolve 和 `depth24plus`；独立输出 pass 负责 ACES，并按 surface 是否为 sRGB 选择硬件编码或显式编码。

Native ABI-3 最初建立了 `depth32float` shadow map、真实 light VP 与 3×3 comparison PCF。当前 forward group 0 已完整绑定 Frame、CSM depth array、comparison sampler、specular/diffuse environment cube、BRDF LUT、environment sampler 与 CSM uniform。OPAQUE 使用 solid depth-only shader，MASK 按是否有 baseColor texture 选择 factor-only 或 texture-alpha discard，BLEND 不进入 shadow pass；三种模式均覆盖 regular/mirrored/double-sided raster 组合，共 9 个 shadow pipeline。Shadow cache 以 `{scene, light, shader}` 版本为键：静态场景在首帧提交后复用，灯光/旋转变化递增 light，成功的 packet 替换递增 scene。`--smoke-shadow` 对同一 GPU HDR 帧分别绑定真实 shadow map 和清为 1.0 的 all-lit depth map，执行两次 forward 渲染并读回 `rgba16float` 像素，要求至少 4 个像素变化且开启阴影后的总线性亮度实际降低；该探针不占用或改写 Frame tuning 语义。`--smoke-shadow-update` 在同一原生 surface 和 renderer epoch 内调用真实 `Renderer::replace_render_packet`，断言相同包零工作、revision 冲突与超范围 bounds 精确回滚、实例增量上传、资源复用和活跃资源数量稳定；第二帧必须提交新的 scene bounds、CSM 计划和 shadow scene version，并以带像素位置的 shadow-on/off HDR 差分签名证明阴影贡献像素实际变化。两帧都必须通过 submission error scopes、uncaptured callback 和 present 检查。

Deep2d GPU painter 接受单子路径的 `move/line/quadratic/cubic/close`。二次和三次 Bézier 使用确定性 De Casteljau 自适应展平，误差同时按 affine 线性变换范数和 display-list `scaleFactor` 换算，目标为变换后 0.25 个物理像素；展平上限为每路径 16,384 段。填充使用简单多边形自交/接触边检查和确定性耳切，支持顺/逆时针凸面与凹面；描边支持开放多段路径、butt/square cap、bevel/miter join 和 miterLimit 回退。它执行命令 opacity、稳定 z-order 和 alpha blending。

当前有意拒绝多子路径/孔洞、自交或近退化多边形、闭合描边、round cap/join、dash、非空 clip、text 和 image。简单多边形轮廓上限为 512 点；超过曲线、轮廓或递归预算时返回 `tessellation-budget-exceeded`。所有未支持输入均返回可序列化的结构化 `Deep2dPainterError`，整个 display list 不会提交部分画面。`--headless-deep2d` 同时执行合同和 painter 能力校验，无需创建窗口或 GPU。

尚未完成：GPU compute tessellation、孔洞/多子路径、闭合描边、round cap/join、clip/dash、原生字体 shaping、交互控件和命中测试；3D 的压缩纹理、自动 mip 生成、HDR/EXR 导入、多级 Bloom 金字塔、雾、OIT、glTF/纹理解码与流式、PBR 画质一致性；以及多窗口输入、中文 IME、文件选择、音视频、脚本宿主、完整 GUI/图表、缓存/诊断界面、离线资源包、安装器、签名、自动更新和 Studio 编辑器接入。当前只接受 OPAQUE/MASK/straight-alpha BLEND；未知 additive/custom/premultiplied 模式结构化拒绝。因此这里已有真实原生纹理、透明、HDR/IBL/Bloom、GPU LOD/剔除、四级 CSM、Shader Package 材质与 Deep2d 首帧，但仍不是完整原生客户端或引擎发布版。
