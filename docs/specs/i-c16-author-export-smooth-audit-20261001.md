# I-C16 作者出图入口与平滑法线核查

本片只核查作者场景如何消费现有CPU路径会话，以及平滑法线真实缺口。标准PBR草稿独立冻结；这里未改生产源或UI。

## 现状核查

1. 全仓packages/apps源与未跟踪文件核查：`apps/web/src` 无 `PathTraceCpuRender`、`createPathTraceRenderPacketKernel` 或 `traceSample` 调用。未跟踪PT源属于本日已有CPU积分/TLAS/CLI实现，不重建。现截图/缩略图读取实时renderer canvas，不能当PT出图入口。
2. 契约：已有SceneSnapshot/SceneMaterialState、RenderPacket GeometryResource交错position/normal、RuntimeSceneCamera、PathTraceCpuSurfaceQuery/session/HDR。TraceHit虽然有barycentricU/V，`rayTrace.ts`明确填0；`rayTraceLayout.ts`合同注释CPU/GPU恒0、16B hit ABI无重心字段。不能据字段名字推断已有插值能力。
3. 依赖：Web/engine已固定Three r185、three-mesh-bvh、Vitest与TS；现有软件TLAS/BLAS无需新增几何库。作者导出既有Blob/objectURL下载模式，无新renderer或状态协议需求。
4. 消费方：`sceneFileTransferActions.ts`实际使用makeSnapshot和snapshotForExport，Topbar消费其持久化导出actions。`compileSceneRenderPacket.ts`已将正式快照、模型loader、GLB decoder、材质覆盖、共享几何/实例变换和AbortSignal编译为正式packet；`compileSceneRuntimePackage.ts`及`probeGridBakeRunner.ts`已有真实消费者。`compileSceneCamera.ts`编译选中保存视图及near/far；PathTraceCpuRender现由Node例子真实消费。
5. 测试/证据：既有adapter回归覆盖静态变换、最近命中、空实例、缓存、flat法线、snapshot不变性、相机裁剪与unsupported拒绝；rtReferenceSemantics测试保留重心0。CPU参考核、session与真实CLI/HDR已有独立积分、重放、取消证据。未发现作者PT浏览器消费或平滑法线验收证据。
6. 规格：remaining I-C16/T10、恢复ledger、reference-integrator、render-packet-adapter、offline-cli-example与dielectric-profile文档均保持整项开放；此前明确flat-only/无作者按钮。历史单BLAS限制已经被静态TLAS适配补上，不能重复建设。

**已有（不重建）**：正式作者快照→RenderPacket编译、资产解码/缓存/覆盖、选中相机编译、软件TLAS一次BLAS缓存、路径积分/RNG/RR、异步会话/逐像素收敛/取消/HDR、作者文件导出/下载模式。

**真实缺口**：Web作者尚未调用PT会话；当前packet adapter明确拒绝smooth法线。TLAS命中没有可用重心数据。当前surface同一个normal同时用于BSDF与epsilon偏移，不能只把flat normal换成插值normal。

## 平滑法线的最小路线

不改既有TraceHit或16B CPU/GPU hit ABI。用closest hit的world t重建世界命中点，经该实例已有worldToLocal转回local；在已缓存triangle position/indices上求Gram重心，插值3个authored normal后inverse-transpose归一化。每geometry/primitive缓存位置、法线与Gram系数，每instance缓存inverse-transpose；当前worldNormals缓存只可保存几何法线，不能把随命中位置变化的插值法线缓存成单值。复用一次preparedBLAS缓存，不再次相交或重建BVH。

surface需区分geometricNormal与shadingNormal。transport用几何法线定向/epsilon偏移和物理半球，着色法线消费BSDF，并明确插值法线与几何/视向不一致、穿越几何半球时的拒绝或校正规则。能量/互易性需要独立数值证据，不能仅做插值示意就解锁全smooth域。最小验证先覆盖顶点/边/内部重心解析值、非均匀缩放/旋转/镜像/shear、多个实例共享几何、源数组后改不漂移、几何epsilon不自交；再验证插值正常/背向异常域、flat逐值兼容与白炉/收敛。

建议锁：新PT局部triangle interpolation叶及测试，`pathTraceRenderPacketScene.ts`、`pathTraceCpuTransport.ts` surface合同与消费；旧BLAS参考核需保留兼容默认geometric=shading。暂不修改TLAS/rayTrace/layout、GPU/ABI或通用几何框架。未实施，不宣称smooth可用。

## 作者入口的最小路线

复用正式makeSnapshot→compileSceneRenderPacket（既有loadModel/normalizeModel/signal）与compileSceneCamera，再消费已有factory和PathTraceCpuRender。设置只需resolution/spp/seed/noise、开始/取消/进度/HDR下载；沿现有控制器的busy/error和Blob下载，处理scene/material/camera修订失效，异步分批必须让浏览器响应取消；不新增renderer。

存在必须先解决的合同差异：runtime package编译先局部化场景并附coordinateFrame，而CPU相机adapter目前拒绝coordinateFrame/section clipping。不能删除frame字段掩盖语义丢失；需独立确认local packet+local camera的正式允许域或显式frame消费。compileSceneCamera固定FOV50、复用保存视图与裁剪；作者出图不能擅自从实时Three相机读另一个状态。

大多数GLB还包含单面/纹理，smooth支持本身不会让普通GLB全可用。入口应先精确校验当前支持域并显示不支持材质/几何原因；不得把纹理降成baseColor或把单面强制doubleSided。环境函数可消费当前真实环境资产，但环境采样/HDR方向映射仍需独立合同验证，不能只把作者背景颜色当全部光照。作者UI另需design skill、两轮浏览器截图与产品验收，本片无视觉完成声明。

下一片优先先补smooth的数值与几何合同，正式支持后再做限定合法profile的作者出图入口；纹理、单面、MIS仍独立后继。

只读CPU复验：2026-10-01 15:33在engine目录运行 `pnpm exec vitest run src/rayTracing/rtReferenceSemantics.test.ts --reporter dot`，10/10通过，实际生产重心0合同仍生效。标准PBR草稿11文件formal beforeSHA与draft afterSHA在15:34再次逐文件核对全部相符，收据 `test-output/i-c16-dielectric-20261001/frozen-source-verification.json`。
