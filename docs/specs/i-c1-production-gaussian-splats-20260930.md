# I-C1 Gaussian splat 生产渲染

复用d60ae021的PLY/.splat解码、64B记录、176B帧参数、CPU深度排序与slot合同，接到现PBR HDR和mesh深度。

## 现状核查

1. packages/apps全源检索、git status未跟踪已查：gaussianSplat模块完整存在，除其index/tests没有slot/resources/shader消费；没有正在实现的同名生产pass。
2. contracts scene无独立splat作者对象；SplatCloud已有records、shDegree、shRest/shRestCount，现核只消费DC。Pbr RenderView/RenderPacket尚无splat对象，新增生产SDK stage沿现renderer资源owner，不另建解码合同。
3. deep-engine package已有WebGPU公开export；Gaussian公开面从src/index.ts re-export gaussianSplat/index，不存在单独./gaussian-splat子路径。已有WGSL mirror sync、Vitest与lab工具，不加依赖。
4. 消费方已查：PbrRenderer可复用opaque/透明/particle→postprocess的位置、HDR/depth、验证作用域、created-device guard和frame capture。Gaussian当前没有生产消费，不复建PBR场景平台。
5. 已查decodeSplatPly/runtimeFormat、sortSplatsByDepth、splatGpuResources/slot/checksum现测试；旧文档明确真机未测。D:/Download已有counter-7k.splat、playroom-7k.splat、bonsai-7k-mini.splat、luigi.ply，可复用并查来源manifest/hash，不编造样本。
6. 已读0930handoff、remaining estimates和权威清单：真实余项slot/管线/排序生产消费、实机出图与mesh共存、高阶SH仅存储的呈现边界。先DC生产，SH边界须显式披露，未验高阶不算有视角相关SH。

已有（不重建）：解码/验证、记录与帧ABI、桶排、slot/blend合同、WGSL真源镜像和样本。真实缺口：生产资源owner、PSO与画面、动态相机排序缓存、失败/取消/替换回收、mesh深度共存和高阶SH状态。

核查发现需先修的旧核问题：triangle-strip旧角点按周界排列形成重叠和漏区；投影矩阵V=JWM后Σ2D取列dot得到VᵀV局部，而正确屏幕协方差需V各行dot（V Vᵀ）。旧exp(-2·offset²)在offset单位为σ时也需按标准Gaussian exp(-.5·offset²)核查，不能把未实机骨架直接当完成实现。

`.splat`字节旋转另有真实错误：[原转换器](https://raw.githubusercontent.com/antimatter15/splat/main/convert.py)按rot_0/rot_1/rot_2/rot_3写wxyz，当前decoder把原字节直接当xyzw。需转换为记录合同的xyzw，并补非对称四元数、非对齐Uint8Array及非法f32回归。EWA公式参考[原论文实现的投影与Gaussian定义](https://github.com/graphdeco-inria/diff-gaussian-rasterization/blob/main/cuda_rasterizer/forward.cu)，本仓独立推导矩阵和CPU参考，不引入外部实现代码或运行依赖。

实景样本：D:/Download/bonsai-7k-mini.splat，8734592B、272956粒，SHA-256 `9e67a38943cd02aa0388c5abf3cb0465a330b7b45ad8aa3d3decc82e5cc8fbb1`；与[发布页](https://huggingface.co/datasets/dylanebert/3dgs/blob/main/bonsai/bonsai-7k-mini.splat)文件SHA一致。仅本机读取，坐标为dataset space，不编造米制标定；样本不随源码提交。另保留小预算合成数学样本供像素/排序/遮挡参考，不能替代整云实际呈现。

资源合同：单owner持有一次64B/粒静态记录、4B/粒排序索引和176B帧参数；相机未变不排序、不上传大缓冲。候选分配沿DeviceSession预算与gpuValidatedStage，最多一个GPU候选；同device世代成功后原子替换，失败/取消保持旧云，已提交旧资源待queue退休。TAA借用现particle-reactive池owner，不另建掩码系统。高阶SH记录保留，首刀status明确sourceShDegree与renderedShDegree=0。

## 实现与验证（已验，待主线程提交）

`PbrRenderer.stageSplatCloud/clearSplatCloud/splatRenderStatus`为生产SDK入口。新owner只接资源生命周期，复用原解码与65536桶排序；记录一次上传，静止帧只写176B，转相机上传4B/粒索引。EWA核修正四元数/协方差/strip/指数，按alpha截止决定覆盖范围，避免2σ边缘硬截断。ABI2新增binding2顺序缓冲、camera near用原176B尾槽；DC入口与TAA双目标入口同一真源。

OIT现有reactive pass借用粒子/GS同一r8，以load+max写入，借用纹理不由OIT释放。Renderer帧owner在提交后、commit/fail前唯一归还；粒子未发布时GS先clear0，已发布时GS保留粒子覆盖。没新增纹理或全帧pass。CPU门43项（原核/owner/frame）；OIT+owner21项，engine与lab类型检查均通过。

实际只深色1920×1080：`gaussian-splats-bare/evidence.json`和`gaussian-splats-taa/evidence.json`各2fresh browser contexts/独立device，全engine/src与WGSL源前后hash相同、errors[]、dispose后resourceCount=0。两门bundle SHA `f828a2b85503796673db6d4ba8ddc38d6262b0a4e568ecbdac04fab33b7d5e54`，canonical SHA `7fa11fd8e8a30f8f99ff32e110ad9b5b80819861f968035b610ca268b0b603c5`、5947B；真实整云源hash沿上述固定样本。

| 证据 | AA关闭且无作者色阶 | TAA开启且无作者色阶 |
|---|---:|---:|
| 独立CPU世界协方差→屏幕投影、9像素最大RGB误差 | .0005541101 | .0004302058 |
| 原记录近层在前、GPU按索引远→近的5像素混合最大误差 | .0002732983 | .0003171798 |
| 3个mesh遮挡样点最大差 | 0 | .0000610352 |
| 2个无遮挡样点最小差 | .6203613 | .6218262 |
| 整云静止/转相机实际画布非背景像素 | 501218 / 499182 | 501325 / 498953 |
| 对应实际画布颜色桶 | 422 / 370 | 419 / 367 |

同相机3整云帧sortCount/orderUploads始终1，转相机变2；17469184B记录仅候选一次传输，排序索引1091824B，帧176B。失败NaN/预取消保持已发布世代，clear移除状态，CPU验证迟到GPU检查/候选互斥/失败重试/queue退休/设备替换。

三写者真实控制直接执行现ParticlePass→GaussianPass→OIT反应pass，以0.9脏mask作负例：有粒子时min/max=102/204、粒子点204、GS点150；Runtime已配但没发布时min/max=102/150、粒子空区102、GS点150。OIT保留同texture身份，两分支资源增量归零；若GS不clear或OIT改为覆盖，以上数值会失败。

首轮整云候选stage为37.1ms（bare）/46.8ms（TAA）；3实际帧cpuSubmit为6.7/1.9/1.4ms与7.1/.9/3.4ms。包括固定R12读回的整帧等待16.8–30ms，属于本机样本测量，不是普通交互FPS指标。CPU保留一次记录快照以隔离调用方后续修改，GPU静态云约18.56MB（记录+索引+uniform）。高阶SH仍只存储，status显式renderedShDegree=0；作者节点、视角SH和新RT排序平台不计入本刀。

## 视觉闭环与同族排查

已核看bare第一轮静止图、TAA第二轮转相机图：树干、花瓣、盆与台面连续可辨，无quad漏区或整帧黑屏。真实mini训练样本带背景浮动椭圆和模糊区域，本刀保留全272956粒，不用过滤后的图替代整云证据。数学参考、mesh遮挡和TAA掩码另有独立实际样点。

10维度自检：布局9.5、令牌9.5、状态9.6、相机变化9.5、3D渲染9.5、反馈9.6、深色1080画布9.5、接口语义9.6；字体与工业信息密度为N/A（SDK画布无新增编辑器）。适用维度95.4/100，范围为生产SDK画布与行为，不作为整套Studio UI评分。对标EWA/3DGS数学来源见前述原始引用，工业mesh深度/ACES/HDR沿现PBR生产栈。

同族核查：粒子反应mask已修的max/clear/唯一回收复用；OIT不再遮掉GS/粒子mask；camera-relative矩阵转换与原mesh jitter一致；原公开64B记录和PLY入口保留；WGSL同步新增`--source`选择只重生成本家族，不重写并行C8文件。

## 精确收割清单（24文件，源冻结）

```text
docs/specs/i-c1-production-gaussian-splats-20260930.md
packages/deep-engine/scripts/syncSharedWgsl.mjs
packages/deep-engine/wgsl/gaussianSplatQuads.wgsl
packages/deep-engine/wgsl/gaussianSplatQuads.wgsl.sha256
packages/deep-engine/src/gaussianSplat/decodeSplatRuntimeFormat.ts
packages/deep-engine/src/gaussianSplat/decodeSplatRuntimeFormat.test.ts
packages/deep-engine/src/gaussianSplat/splatGpuResources.ts
packages/deep-engine/src/gaussianSplat/splatGpuResources.test.ts
packages/deep-engine/src/gaussianSplat/splatQuadsWgsl.ts
packages/deep-engine/src/gaussianSplat/splatQuadsWgslChecksum.test.ts
packages/deep-engine/src/gaussianSplat/splatProjectionCpu.ts
packages/deep-engine/src/gaussianSplat/splatProjectionCpu.test.ts
packages/deep-engine/src/webgpu/gaussianSplatPass.ts
packages/deep-engine/src/webgpu/gaussianSplatSceneOwner.ts
packages/deep-engine/src/webgpu/gaussianSplatSceneOwner.test.ts
packages/deep-engine/src/webgpu/pbrSplatFrame.ts
packages/deep-engine/src/webgpu/pbrSplatFrame.test.ts
packages/deep-engine/src/webgpu/pbrRenderer.ts
packages/deep-engine/src/webgpu/pbrTransparencyPass.ts
packages/deep-engine/src/webgpu/pbrTransparencyPass.test.ts
packages/deep-engine/src/webgpu/index.ts
packages/deep-engine/lab/iC1GaussianSplatProduction.ts
packages/deep-engine/lab/iC1SharedReactiveMask.ts
scripts/i-c1-production-gaussian-splats.mjs
```

## 计划与锁

先新增独立投影/覆盖数学参考与回归，再沿现splat资源/WGSL修正。共享pbrRenderer需主线程I17构建收割后释放；pbrShader/C8与Native归其他路，不触。只深色1920×1080两fresh真实GPU。

Design Read：对标标准3DGS EWA投影与现工业PBR深色场景，单一实景云作为主视觉；容器沿base.css，模型色来自样本。
