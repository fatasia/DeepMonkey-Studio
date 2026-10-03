# I-C16 RenderPacket 静态实例 CPU 适配（2026-10-01）

## 现状核查

1. 全仓packages/apps及未跟踪文件已核查：现有 `buildRenderPacketRayScene`，前切片CPU路径核/session/HDR；应用没有PT导出消费方。未跟踪I-C19/I-C23/J3修改保留。
2. 契约：复用 `RenderPacket`/`PbrMaterial`/`GeometryResource`、`RuntimeSceneCamera`、`TlasBuildResult` 和 `PathTraceReferenceKernel`；不另建场景/相机状态。
3. 依赖：TypeScript/Vitest/Three已在用，本片不加运行依赖，不依赖GPU/Native。
4. 消费：RenderPacketRayScene已用于探针场辐射GPU生产链；traceTlasClosest是GPU对拍权威，不能复制遍历或另造BVH。正式RuntimeSceneCamera在runtimePackage及Web桥中已有消费；目前CPU核没有正式相机适配。
5. 测试与证据：RenderPacketRayScene 3测，TLAS 8测，CPU PT 27测与RT/HDR346通过；旧TLAS空实例测试只放尾部，未覆盖前/中空实例。审查发现每条射线每实例重新buildTracedScene，以及稀疏参与实例order漂移风险，先补失败回归。
6. 规格：已读remaining、主计划T10、i-c16产品状态机和reference-integrator报告、GLM handoff与台账；正式场景/纹理/产品UI仍未完成，禁止子集关闭整项。

### 已有（不重建）

RenderPacket验证/几何快照、RenderPacketRayScene变换适配、TLAS/BLAS遍历、相机校验、CPU transport/BSDF、session/HDR链。

### 真实缺口

正式RenderPacket静态实例→多跳surface-query适配、共享CPU transport接口、快照持有BLAS缓存、空BLAS前/中实例order回归、正式相机剖切/坐标框架边界。

## 实施范围与锁

主线已批准：新增pathTraceRenderPacketMaterial/Scene/Kernel叶及测试，新增共用pathTraceCpuTransport叶；修改pathTraceCpuKernel仅提取同一积分循环、tlas仅可选prepared resolver与空实例order修复、tlas.test回归；末次index导出。

合法材质子集：OPAQUE、doubleSided=true、无纹理/扩展/分层/顶点色，metallic=1的GGX导体，或metallic=0且ior=1的Lambert。普通ior=1.5介质含Fresnel高光，禁止静默当Lambert。flat几何法线需与三角几何法线一致（1e-5），不把smooth/normal map降格。静态实例支持平移/旋转/非均匀缩放/镜像；pose/LOD/deformation明确拒绝。

RuntimeSceneCamera复用权威校验。仅无coordinateFrame/剖切的Y-up perspective，near/far只裁切主射线，后续路径仍在世界中传播。坐标框架与剖切在支持前明确拒绝；不把相机相对坐标误当世界坐标。

场景快照归核持有，复用同一资源BLAS；缓存一次构建后经可选resolver注入traceTlasClosest。旧traceTlasClosest默认重建语义保持，其他消费者未被强制切缓存。失效建立新核，旧核随消费者释放引用回收；缓存不跨修订/用户场景共享。

缓存所有权：`buildTlas.preparedBlas` 按BLAS对象身份构建一次；适配器持有prepareRenderPacket复制的几何、复制的材质/实例矩阵、相机校验快照，resolver只能访问该快照Map，缺项即抛。多个实例共享该几何BLAS；法线按命中过的instance/primitive惰性缓存，不预先展开所有实例顶点/法线。工厂仅向消费方暴露traceSample、profile、instanceCount、uniqueBlasCount；缓存不暴露可写入口。

## 验证门

先失败回归：空BLAS位于前/中不漏后续实例；原始instance索引与GPU pack布局一致；最近命中/t缩放/缓存一次构建。实现后正式实例解析白炉与镜像/非均匀变换、材质拒绝矩阵、camera近远裁切、作者数组修改隔离、真实session/HDR消费及同族回归。零GPU/Cargo/UI/commit，整项保留。

## 实测与交付

- 先红后绿：软件TLAS前/中空BLAS使order实为 `[0,1]` 而应为 `[1,3]`；修复紧凑顶点base和participating→original instance映射。两条新增回归覆盖CPU最近命中和packTlasScene原始索引，不改GPU内核。
- 新正式适配19测、TLAS新增2测通过。平移/旋转/非均匀缩放+shear/镜像、最近实例材质、共享几何一次缓存、数组/相机快照、近远主射线裁切、真实Lambert session/HDR、unsupported矩阵均通过。正式RenderPacket的空几何仍被权威validator拒绝，软件TLAS空BLAS合法域另有回归，未放宽契约。
- 正式GGX全金属adapter与既有单BLAS参考512个同seed样本逐位相同；两者共用同一transport、同一C3 BSDF评估，无第二套积分器。
- 最终RT/HDR+正式camera回归40文件421通过、1既有跳过；完整pnpm run typecheck（src/lab/examples）及最终源码tsc --noEmit通过；runtimePurityGate通过；包级sourceSizeGate2911文件、failures=0。
- 相关新叶最大148行、TLAS源码151行/测试153行，低于301阻断门。
- 证据：`test-output/i-c16-render-packet-20261001/{vitest.txt,purity.txt,source-size.txt}`。

主包新入口 `createPathTraceRenderPacketKernel({packet,camera,width,height,environment,...})`，输出profile为 `opaque-two-sided-flat-lambert-ior1-or-ggx-metal`，接既有PathTraceCpuRender即可累积/失效/取消/导出。环境函数仍要求纯函数；场景/相机/材质修订由消费者身份管理。

源码已冻结交主线sync/build。未做产品侧按钮/调度/进度/下载/浏览器视觉闭环；未覆盖普通介质、纹理、smooth/shading-normal、单面/透明/扩展/分层、动态实例/refit、相机坐标框架/剖切、MIS/降噪、GPU对拍。I-C16/T10整项保持未关闭。
