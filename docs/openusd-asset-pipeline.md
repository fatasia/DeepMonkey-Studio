# OpenUSD 原生查看管线

## 定位

项目使用 Three.js 0.185.1 官方 `USDLoader` 作为 USD、USDA、USDC、USDZ 的原生查看主路径。上传后保留原文件并直接生成 `viewerKind: "usd"` 的 manifest；查看器按需下载 USDLoader，不依赖外部 Provider，也不会进入 `waiting_converter`。

这条路径解决的是开放场景资产的浏览、交互与发布，不把 OpenUSD 误当成 RVT、JT、X_T 等工业 CAD 的通用转换器。后者仍由各自格式链路负责。

```text
USD / USDA / USDC / USDZ 原文件
           │ 上传并保留，同一资产 ID
           ▼
     viewerKind: usd manifest
           │ Three.js USDLoader 按需加载
           ▼
  WebGL / WebGPU 编辑、浏览与离线客户端发布
```

## 已实现行为

- 服务端四种扩展名都直接进入 `ready`，manifest 的 `geometryUrl` 指向保留的源文件。
- 本地客户端同样把四种格式作为直接查看资产，不要求填写服务地址。
- 查看器通过统一资产读取边界取得 `ArrayBuffer`，由官方 USDLoader 自动识别 USDA 文本、USDC crate 或 USDZ 包。
- USDZ 的根层与包内贴图由官方加载器在内存中解析；独立 USD 的相对资源使用源文件 URL 作为基准路径。
- 场景层级沿用 Three.js 对象树；材质、纹理和动画在加载器返回后进入现有选择、显隐、动画和脚本工作流。
- 常规 glTF/IFC 首屏不下载 USD 解析代码，避免把 USDC 解析器成本强加给所有用户。
- 当前发布运行时能够直接加载 USD，因此不强制生成 GLB。未来若某个交付目标明确只接受 GLB，应在发布前用受控 USDLoader + GLTFExporter 转换一次，而不是源格式预览后热切换几何。

## 真实样本证据（2026-08-31）

以下文件来自 OpenUSD 官方仓库，许可证随上游仓库；测试把最小二进制样本固化为离线回归数据，CI 不访问网络。

| 格式 | 官方路径 | SHA-256 | 实测结果 |
| --- | --- | --- | --- |
| USDA | `extras/usd/tutorials/convertingLayerFormats/Sphere.usda` | `46125ff598d33adec250a6d34832904550969e53c8c1e8288e506d5c68090739` | 1 网格，960 三角面，法线/UV/基础材质存在 |
| USDA 动画 | `pxr/usd/usdSkel/doxygen/skinnedArm.usda` | `7781ad132e0ccbef432f88f8f37a13076fcabc0a43f08775619d159d19d5600a` | 1 个蒙皮网格，20 三角面，1 条骨骼动画/1 个轨道 |
| USDC | `pxr/usdValidation/bin/usdchecker/testenv/testUsdChecker/clean/geom.usdc` | `1bdd3dece2295de7837a95b1b0b7938fb331386f9c46b6c380b10445573a48cd` | 5 个有效网格，3276 三角面，命名层级与材质存在 |
| USDZ | `pxr/usd/usdUtils/testenv/testUsdUtilsCreateNewUsdzPackage/nestedUsdz/simpleMesh.usdz` | `18ede477be83ca5e1cb086cc8615860e764e9f9b4976a1942f6ef9d00c02ee70` | 包内 USDC 正常解析，1 网格，12 三角面，命名层级与材质存在 |
| USDZ 贴图 | Three.js r185 `examples/models/usdz/saeukkang.usdz` | `dcc70e52a2468aeea3f63da3505ffe371bc7cf7c22e81b6c53b7f909a3e44d42` | Chrome 实际加载 1 网格/25000 三角面/1 张完成解码的贴图 |

聚焦回归：

```powershell
pnpm --filter @bim-studio/web test -- src/viewer/openUsdModelLoader.test.ts
pnpm --filter @bim-studio/api test -- src/industrialFormatWaitingAcceptance.test.ts
```

官方 API 说明：[Three.js USDLoader](https://threejs.org/docs/pages/USDLoader.html)。官方实现明确支持 ASCII USDA、二进制 USDC，以及以两者为根层的 USDZ。

## 真实能力边界

- 已用 OpenUSD 官方骨骼样本验证动画，用 Three.js 官方 USDZ 样本在真实 Chrome 中验证包内贴图；尚未形成大规模动画、复杂材质和多贴图资产矩阵。
- USDLoader 是面向实时渲染的解释器，不是完整 OpenUSD stage/composition 实现。复杂 sublayer、payload、reference、variant、resolver、MaterialX、物理 schema、灯光语义和自定义 schema 需要按客户样本逐项验证。
- 原始属性不会自动变成完整的 `properties.json`/PMI sidecar；当前可选择层级来自 Three.js 对象树，不等价于完整 USD 元数据浏览器。
- USDZ 包必须符合官方加载器接受的根层组织方式；异常包会明确加载失败，不会回退到假几何或外部转换等待状态。
- “支持 OpenUSD”不等于可以无损打开任意 DCC/Omniverse 场景，也不等于原生解析 RVT、JT、X_T。
