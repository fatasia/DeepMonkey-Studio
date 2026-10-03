# CPU 静帧出图例子

这个Node例子把正式RenderPacket JSON与RuntimeSceneCamera送入CPU路径追踪，输出线性Radiance HDR。支持静态双面几何、合法平滑法线与scene-local相机、无纹理不透明PBR，含介电/混合金属与C8多散射；纹理、单面、透明和分层材质给出unsupported错误。

- 同一积分核追踪静态实例，共享几何只构建一次BLAS。
- 固定seed重放；异步分批，Ctrl+C取消。
- 每像素噪声超限时拒绝最终出图，显式preview写独立文件和回执。
- HDR回执记录输入/输出SHA-256、样本数、噪声与RGBE往返误差。

在`packages/deep-engine`运行：

```powershell
pnpm run build
node examples/offline-path-trace-fixture.mjs create ../../test-output/path-trace-example
node examples/offline-path-trace.mjs --packet ../../test-output/path-trace-example/scene.json --camera ../../test-output/path-trace-example/camera.json --output ../../test-output/path-trace-example/result.hdr --width 64 --height 32 --spp 16384 --seed 17
node examples/offline-path-trace-fixture.mjs verify ../../test-output/path-trace-example/result.hdr
node --test examples/offline-path-trace.test.mjs
```

`--spp`是实际每像素样本数，`--batch`默认为8；`--noise-threshold`默认0.05，`--environment`是线性RGB（默认`1,1,1`）。输出排他创建，重复运行换文件名。噪声未过时exit2且不写final；加`--preview`只写`result.preview.hdr`与preview回执，exit2。取消exit130；非法/unsupported输入exit1。

场景JSON复用已有序列化合同，例子相对导入`dist/runtimePackage/renderPacket.js`的materializer；该内部模块不是公开SDK子路径API。例子没有接作者UI，也未覆盖完整材质、纹理、MIS、降噪或GPU路径。数值边界见[适配报告](../../../docs/specs/i-c16-render-packet-adapter-20261001.md)。

材质profile为 `production-opaque-two-sided-pbr-single-and-multiple`；原显式Lambert/GGX参考核仍保留。生产stock diffuse未减Fresnel，白介质炉可略高于1，证据记录实际积分值。材质扩展后的例子验证使用16384spp，噪声和HDR门保持原值。

带coordinateFrame的相机和packet必须来自同一局部化编译，积分保持local坐标；kernel保留该frame供world归属。法线必须为单位、与几何法线同半球；变换后反向法线明确拒绝，section clipping仍不支持。着色法线背向观察方向时贡献为零；光照采样不跨几何背半球，强倾斜法线因此可能变暗，相关数值门见[平滑法线规格](../../../docs/specs/i-c16-smooth-author-profile-20261001.md)。
