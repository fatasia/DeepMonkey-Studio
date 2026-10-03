# 按材质 ID 编辑和保存两层表面

这个 SDK 示例给已有 RenderPacket 的一个材质设置清漆和金属两层，替换已有层行并保留 `layered.base`，使用公开 API 保存完整 RuntimePackage。几何、实例和原 packet 保持不变。

```ts
import { withCoatMetalLayers, serializeCoatMetalPackage } from "./layered-material-authoring.js";
import { parseDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";

// sourcePacket 来自已有导入或场景构包；materialId 必须唯一存在。
const authored = withCoatMetalLayers(sourcePacket, materialId);
await renderer.setPacketValidated(authored);

const json = serializeCoatMetalPackage({
  packageId: "painted-scene",
  packageVersion: "1.0.0",
  renderPacket: { id: "scene", revision: 2, value: sourcePacket },
}, materialId);

// 写入本地文件后，读取同一 JSON；交给已有 RuntimePackage 加载路径。
const restored = parseDeepRuntimePackage(json);
if (!restored.valid) throw new Error(restored.issues[0]?.message);
```

`renderer` 创建时需要 `features: { layeredMaterials: true }`。保存时指定新的 packet revision；材质 ID 和实例引用由已有包校验处理。示例拒绝找不到或不唯一的材质 ID。

两层分别使用 replace 和 overlay，后者权重取层的完整生产响应。显式金属层要求 metallic=1，不支持同层清漆、透射或 MR 纹理。示例的颜色是线性 RGB。

公开 `evaluateLayeredSurfaceDirect` 可检查直接光响应；完整画面仍由 PbrRenderer 的主光、IBL、局部光和发光路径计算。Web 已准入层序组合两 fresh 的24帧验证通过；Native 新组合尚待实测。

这是 SDK packet 作者入口。Studio 的 SceneMaterialState、材质命令与 Three 作者预览尚未接层栈；Three 非中性 MeshPhysical 扩展的明确拒绝保持。
