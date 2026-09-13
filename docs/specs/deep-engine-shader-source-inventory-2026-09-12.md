# Deep Shader：当前源码迁移语料清单

日期：2026-09-12。状态：静态源码基线，不是兼容率或运行时通过证明。

## 扫描结果

扫描当前工作树的 `apps` 与 `packages` 静态代码，排除 `packages/deep-engine` 自身、构建目录、依赖、公开资产和模型。共纳入 2,239 个文件，语料 SHA-256 为 `c9825233d589b833d588e50d0474d63e0714ec837b210dbdf5db9f66a58ba4c5`。

| 证据种类 | 出现次数 |
|---|---:|
| `onBeforeCompile` 访问 | 10 |
| `customDepthMaterial` | 2 |
| `customDistanceMaterial` | 2 |
| 嵌入 GLSL/HLSL 特征源码 | 6 |
| `vertexShader` 属性 | 1 |
| `fragmentShader` 属性 | 3 |
| `customProgramCacheKey` | 3 |
| Three Shader 构造器 | 1 |
| `three/tsl` 导入符号 | 10 |
| 合计 | 38 |

证据主要集中在：

- `viewerEngineObjectState.ts`：Fresnel rim 的 `onBeforeCompile`、fragment chunk 替换与自定义 cache key。
- `webGpuPostProcessingRuntime.ts`：10 个 TSL 符号，属于 Three WebGPU 后处理迁移语料。
- `postProcessingRuntime.ts`：显式 vertex/fragment 源码。
- `repeatedAssetBatcher.ts`、`offscreenSceneCompatibility.ts`：编译 hook 与自定义 depth/distance material 相关正确性边界。
- `conservativeOcclusion.ts`、`occlusionSolidGeometry.ts`：对自定义编译 hook 的兼容资格检查。

原始逐文件、逐行证据和完整文件 manifest 见 [JSON 清单](deep-engine-shader-source-inventory-2026-09-12.json)。扫描器测试覆盖 Three shader 构造器/Hook、TSL、WGSL/GLSL 字符串、shader 文件导入、动态入口和确定性。

## 边界

38 是静态“出现次数”，不是 38 个独立 Shader，也不是已经兼容。相同源码行可能访问两侧对象而产生两条真实证据；测试文件也保留在分母中，以免迁移后丢失行为断言。

当前扫描没有静态解析失败或动态 shader import，但仍缺少：数据库中的项目脚本、发布应用脚本、运行时源码拼接、生成代码、`assets/models/public` 下的文件、Unity ShaderLab/Shader Graph 资产、实际材质绑定、运行时分支和视觉一致性。后续必须采集这些来源并运行代表项目，不能用本清单替代。

## 迁移用途

`SHADER-05` 先冻结这 38 条静态证据并逐项映射到 Deep template/typed graph/code subset/manual port。`onBeforeCompile` 与 Three shader chunk 字符串替换不能带入 native runtime；Fresnel rim 应变成可序列化 graph/subgraph，后处理 TSL 应变成 Deep render graph + fullscreen/compute Pass，自定义 depth/distance 行为应映射为明确的 depth/shadow Pass。
