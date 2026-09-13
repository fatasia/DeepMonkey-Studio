# Deep Engine S1：默认材质管线与设备验证

日期：2026-09-12。已完成：本文件描述的独立固定夹具闭环。**本轮待办：通用场景/模型与完整默认画质。项目级后验收：Unity、UE5、Godot 对照及 Three/Babylon 平替。**

## 用户决策与隔离

- 自主控制引擎核心，开源项目提供研究参考；本次运行时没有 Orillusion、Three、Babylon 依赖。
- 默认视觉与性能以 Unity、UE5 为对照目标，不能依赖逐个示例场景手工堆效果；此处没有达标声明。
- 只修改 `packages/deep-engine`、开发锁文件与引擎文档；没有修改正式 apps 渲染入口、设置、项目/脚本、账号或存储。没有提交和 push。
- 本地服务器仅监听 `127.0.0.1:5291`，只提供白名单静态资源和本地验证记录写入，无产品 API/数据库调用。
- `lab:isolation` 检查构建输入仅来自自有 src/lab、无引擎运行时依赖、正式 apps 无实验包引用。

## 已完成的实现

| 模块 | 当前真实行为 |
|---|---|
| 设备生命周期 | 每个实例独占 device/context/受管资源；能力不足明确失败；取消立即返回，迟到 device 释放；丢失后停画，显式重建 |
| 默认环境 | GPU 生成摄影棚 cubemap、8 级 GGX 预过滤、漫反射辐照度、DFG LUT；每次设备初始化只预计算一次 |
| 材质 | 自有 WGSL：GGX、Smith、Schlick、split-sum IBL 与高粗糙度能量补偿；显式金属度/粗糙度 |
| 阴影 | 2048 深度图、PCF、偏移控制；实例数据或光照范围变化才更新；相机/曝光变化复用静态阴影 |
| 输出 | 线性 rgba16float HDR、4× MSAA、阈值 Bloom、Vignette、曝光、ACES 曲线近似、一次显式 sRGB 编码 |
| 绘制 | 重复球体共享几何并实例化；首帧含阴影 4 次 draw，缓存命中 3 次，空实例场景 2 次 |
| 尺寸 | 零尺寸暂停、不创建零尺寸纹理；限制 DPR 与设备纹理上限；更换尺寸退役旧附件 |
| 计时 | timestamp-query 可选；诊断采样才启用，最多 3 组异步读回，忙时跳过测量，保留实际样本数 |
| 记录 | CPU 提交 / GPU 时间 / RAF 间隔分开；包含可用适配器信息、实际渲染尺寸、构建及静态资产 SHA-256 |

默认环境是自有程序生成的摄影棚，并非已经支持任意外部 HDRI；IBL 不等于实时场景 GI 或实时反射。阴影缓存目前服务于此管线的固定光源合同，不能直接套用到未来任意动态灯光。

## 自动验证

- `typecheck`：核心与实验页通过。
- `test`：9 个 Vitest 文件、67 项测试通过；另 5 项 AST 扫描器测试通过，共 72 项。
- `build`、`lab:build`、`lab:isolation` 通过；默认/显式 WebGPU 构建入口可在无 DOM 的 Node 中导入，导入本身不请求设备。
- 全仓 `quality:source-size`：2470 个源文件通过；自有新增模块均低于 300 行。
- 失败/边界覆盖包括：取消等待 adapter/device、迟到设备清理、配置失败、设备能力缺失、可选计时回退、重复销毁、独立设备隔离、释放异常、尺寸极值、相机退化、顶点绕序、实例非法数据、异步计时读回失败及池满跳过。

## 真实浏览器证据

最新构建标识：`9f343a7a2cca3af13857a2ef89e659974f4973fab16fce4d821762d2cb5c0771`。
实验页 JS：38,054 bytes，gzip 13,244 bytes。**这是固定夹具及其 UI 的 JS，未计 CSS；不是完整引擎或最终兼容包大小。**

权威本机记录：

- [宽屏、GPU 采样、设备丢失与恢复](../../test-output/deep-engine/webgpu-1789168444697.json)
- [480 px 浅色、尺寸恢复后无溢出](../../test-output/deep-engine/webgpu-1789168474827.json)
- 较早 IBL 构建记录 `webgpu-1789168301940.json` 单独保留，不冒充最新构建。

最新记录设备为 NVIDIA / lovelace / 非 fallback；浏览器未提供具体型号和驱动。Chrome 152，实际渲染附件 1274×493（页面视口 1920 px，二者不同）。默认曝光/粗糙度倍率 1，先预热 20 帧，再采 120 帧：

| 实例数 | CPU 提交 P95 | GPU P50 / P95 | 有效 GPU 样本 | 绘制 / 阴影更新 |
|---|---:|---:|---:|---|
| 49 | 0.30 ms | 0.13 / 2.23 ms | 118/120 | 每帧 3 draw；120 帧内 0 次阴影更新 |
| 1024 | 0.30 ms | 0.39 / 0.39 ms | 118/120 | 每帧 3 draw；120 帧内 0 次阴影更新 |

GPU 时间戳存在量化，且小场景 P95 有明显波动。这是单机开发环境诊断，不是隔离负载、多轮统计或竞品基准，不从中推导 1080p/4K 性能、稳定 FPS 或领先百分比。

实际注入 `device.destroy()` 后：旧实例 `lost`、停止绘制；销毁后受管资源数 0；新实例重建环境并通过真实 GPU 首帧。平时 15 个受管对象，计时池最多额外 9 个对象；池停止采样后保留供复用，设备销毁时统一释放。此计数不是驱动显存实测。

已实际操作实例数 49/256/1024/0、粗糙度、曝光、环绕启停、重建设备、设备丢失与恢复、主题、页面宽度控件和记录保存。采样中修改曝光实际触发取消，防止混合条件污染样本。控制台和记录未发现未处理错误；设备丢失注入事件作为预期诊断单独记录。结束前已恢复默认主题/曝光并撤销浏览器视口覆盖。

## 视觉闭环与遗留

使用 `design-taste-digitaltwin`。Design Read 已声明：Unity 的材质/光照管线，山海鲸的空间氛围，西门子的克制信息层级；UI 和夹具配色由 `apps/web/src/styles/base.css` 令牌取得。

第一轮发现并修复：ResizeObserver 回调内改变布局引起循环警告；窄屏统计栏覆盖前排球体；窄屏控件排列不顺。修复采用 RAF 时机更新布局、独立画面/统计区、单列窄屏控件。第二轮及后续实际截图覆盖 1920/1280/980/800/480 px 与深浅主题，画面与统计区无重叠；DOM/报告检查无横向溢出。IBL 升级后再次复验宽屏与浅色窄屏。

| 自评维度 | 分数 / 10 | 依据或剩余问题 |
|---|---:|---|
| 布局构图 | 9 | 画面、统计和控件分区，修复遮挡 |
| 令牌一致性 | 9 | UI/背景/雾/材料样例配色来自既有令牌 |
| 排版 | 9 | 字阶、数值单位与窄屏换行核验 |
| 交互状态 | 9 | 编译等待、失败重试、禁用原因、空实例状态、焦点 |
| 动效质量 | 9 | 环绕 delta time 驱动，可停，响应 reduced-motion 偏好变化 |
| 3D 渲染质量 | 8 | IBL/阴影/HDR 已有，尚缺真实资产、透明/纹理、接触遮蔽与时间稳定性对照 |
| 信息设计 | 9 | CPU/GPU/RAF 分开，尺寸和测量样本显式 |
| 反馈即时性 | 9 | 操作先更新状态，再异步编译/采样/恢复 |
| 响应式与主题 | 9 | 相关五档与双主题实测，窄屏无遮挡 |
| 语义与文案 | 9 | 技术验证页，能力未实现和计时限制明确 |

**未宣称通过完整 Kimi-95/Unity/UE5 视觉验收。**3D 质量项未达 9，继续进入真实资产和完整管线验证；不能以材质球截图代表完整引擎画质。

## 下一批次与对照纪律

1. 把几何/材质/实例提取为通用 RenderPacket，加入真实模型、纹理和多对象状态；接近生产场景后再选择高收益优化。
2. 补 HDRI/环境设置、透明与法线材质、接触遮蔽、反射与抗锯齿稳定性；沉淀默认配置而非每个场景单独改 shader。
3. 固定 Unity HDRP / UE5 的实际版本、场景、资产、光照功能、硬件、内部/输出分辨率与质量档；同时比较图像误差、GPU/CPU P50/P95/P99、显存、首帧和交互。
4. 同等功能/画质后才比较性能。UE5 的 Lumen、TSR 和本夹具 IBL 不是同一工作负载，不能拿此处亚毫秒 GPU 数据和它的 GI 预算直接比较。
5. 正式应用仍保持 Three；项目兼容与切换门禁通过后，才进入设置的一键切换接入。

参考：Unity 官方 [HDRP 反射探针](https://docs.unity.cn/Packages/com.unity.render-pipelines.high-definition%4017.4/manual/reflection-probes.html)、Epic 官方 [Lumen 性能指南](https://dev.epicgames.com/documentation/unreal-engine/lumen-performance-guide-for-unreal-engine)。它们用于确定对照功能和预算口径，未在本轮跑竞品实测。

## 2026-09-12 后续纹理增量

本节保留上文 S1 固定材质球的历史构建身份，同时记录其后的通用 RenderPacket 纹理增量，不用新结果覆盖旧证据：

- 新增 UV0、RGBA8 sRGB/linear、sampler、mip/预算/所有权、baseColor 与 metallic-roughness 槽位，以及几何/实例/材质/纹理共同回滚的 GPU 事务。
- 新增嵌入 PNG/JPEG、`KHR_texture_transform` 和宿主图片解码器注入；实验页实际解码并显示 Khronos BoxTextured。
- WebGPU 实际通过纹理首帧、错误回滚、device loss 后重建和资源回落；报告为 [webgpu-1789204519285.json](../../test-output/deep-engine/webgpu-1789204519285.json)。对应构建为 `f9abd32fab367d81bb319f01bd0a57a39b296011b96866d53404647d09a183f7`，JS 102,185 bytes、gzip 33,098 bytes。
- 包级最终复验为 26 个 Vitest 文件 334 项、5 项 AST、typecheck/build/lab build 全部通过。法线贴图、透明、复杂真实模型和竞品冻结基准仍未完成，3D 视觉项仍不能给 9 分。

## 2026-09-12 法线、AO、发光与透明增量

本节覆盖上方纹理增量的旧边界，记录当前最新状态：

- `NormalTangentTest` 已通过真实 GLB 解码、运行时切线生成、normal map、R 通道 AO、双面光照和镜像 TBN；`MaterialModes` 自有合同样本已贯通 emissive、MASK 和 BLEND。
- emissive 纹理使用 sRGB 采样，乘线性 factor 后在 HDR tone mapping 前叠加；MASK 的颜色与阴影共用 alpha cutoff；BLEND 使用独立透明 pass、关闭深度写入、按相机从后向前稳定排序且不投射阴影。
- 最新 Browser Lab 构建为 `45bcfe98850d8ce9eaeac71906efd2128893e4bbaeb5527c919d9a92d732ce11`，JS 122,568 bytes、gzip 38,647 bytes。记录为 [webgpu-1789210101595.json](../../test-output/deep-engine/webgpu-1789210101595.json)。
- 本机 Chrome 152 / NVIDIA Lovelace / 非 fallback 实测：法线样本单模型在 747×407 附件下 4 draw、21 个受管资源；MaterialModes 在 980 px 页面档位、654×660 附件下，阴影缓存帧 5 draw、设备重建首帧 7 draw、22 个受管资源。
- 第一轮把单模型相机拉近后暴露顶部裁切；第二轮同时调整距离与目标点，模型居中且无遮挡。980 px 双栏截图复验无横向溢出。上传失败候选完整回滚，原场景继续渲染；注入设备丢失后旧资源归零并完成重建首帧；控制台 error/warn 均为 0。

官方 `AlphaBlendModeTest` 的非 normal-map primitive 携带 TANGENT，`TextureEncodingTest` 的两个 billboard 缺 NORMAL，均被当前严格几何合同拒绝；没有放宽解析器或把被拒样本冒充通过。来源 commit、URL、字节、SHA-256、许可与阻塞原因记录在 `packages/deep-engine/lab/assets/sources.json`。这批证据提升了材质覆盖，但仍不是完整 Unity/UE5 画质或性能对照，3D 视觉项保持 8/10。

## 2026-09-12 UV1 与逐槽坐标集增量

- RenderPacket 几何新增可选 UV1，baseColor、metallic-roughness、normal、AO、emissive 每个纹理槽独立选择 UV0/UV1；固定材质 ABI 用 `0=disabled / 1=UV0 / 2=UV1` 编码，没有增加材质 pipeline 变体。
- glTF 严格读取 `TEXCOORD_1` 与 `KHR_texture_transform.texCoord=1`；normal/TBN 使用法线贴图指定的 UV 集生成。Three r185 的 `geometry.uv1 + texture.channel=1` 可精确投影，缺 UV1、channel > 1 和 MR 跨通道组合明确拒绝。
- Browser Lab 新增自有 `UV0 色彩 / UV1 AO` 合同场景：保留未修改 BoxTextured 的 UV0/baseColor，添加旋转 UV1 和棋盘 AO。与同相机的 BoxTextured 前后画面对照中，基础场景保持原图，UV1 场景显示独立 AO 棋盘，因此不是只验证字段存在。
- 最新构建 `50a0dd8a8dbe372988d8cf80b1e3c6efd061f370e4519c6c8dc75a794aa37134`，JS 124,400 bytes、gzip 39,317 bytes；记录为 [webgpu-1789211876015.json](../../test-output/deep-engine/webgpu-1789211876015.json)。Chrome 152 / NVIDIA Lovelace / 非 fallback，747×407 附件，单实例 4 draw、27 triangles、18 个受管资源，控制台 error/warn 为 0。
- 聚焦 5 个测试文件 41 项通过；共享全包在 UV1 开发完成点曾为 36 文件 479 项 + Node 22 项、typecheck/build/runtime purity 全绿。随后 Shader IR 并行开发形成新的中间态，最终全包由根任务在所有并行批次结束后重跑。

该场景只证明当前两个坐标集和逐槽选择；更多 UV 集、lightmap、clearcoat/transmission 等扩展纹理坐标仍未支持，完整 Shader/材质矩阵继续待办。
