# DE26/C02 第一切片 · 顶点色与平面着色（合同冻结 + Three/Native 接通）

日期：2026-09-17。卡：DE26/C02（P1）。范围：可选颜色流 ABI 冻结、flatShading 几何派生合同、
materials.ts 解除一刀切拒绝、Three→packet→Web/Native 链路、旧包/golden 逐字节不变。

## 冻结内容

- **可选颜色流（packet 合同）**：`GeometryResource.colors?: Float32Array`（线性 RGBA f32，
  与顶点一一对应；三维颜色源 alpha 固定 1，不覆盖时不产生该字段）。存在性成为显式字段：
  `GeometryFeatures.colors: boolean`（必填，与 uv0/uv1/tangents 同型）。
- **颜色流 ABI（shader 合同 v4）**：`deep.pbr.mesh.v4` = v3 + 新 vertex stream
  `{ id: "color", slot: 3, arrayStride: 16, attributes: [COLOR_RGBA_F32_LINEAR @ location 16, float32x4] }`。
  v1/v2/v3 canonical JSON + SHA256 逐字节冻结不动；v4 的 passVariants/materialModes/dataLayouts
  与 v3 完全一致——**颜色变体的管线接入必须走新的修订，不得复用 v4 静默改语义**。
  Native 对应常量：`COLOR_VERTEX_FLOATS=4`、`COLOR_VERTEX_BYTES=16`、`COLOR_VERTEX_ATTRIBUTES=[16 => Float32x4]`。
- **flat 派生合同**：flatShading 不改 shader，改为「非索引几何 + 面法线」的几何派生
  （`threeBridge/flatGeometry.ts` 纯函数）。面法线 = normalize(cross(AB, AC))，方向由绕序唯一
  决定（对象局部空间）；实例镜像/非均匀缩放不在派生作用域内，正背面语义由渲染端
  ccw 绕序 + mirrored 批次翻转承接。退化面（|cross| < 1e-8）与越界索引 fail-closed 拒绝。
  派生设置进资源身份：几何 ID 后缀 `/flat`、`/color`（同 normalTexCoord 先例），
  且 `projectGeometry` 的 stamp 含 flatten/vertexColors 开关——改设置 = 改 ID = 改资源。

## 拒绝语义（materials.ts）

- 原 `if (m.wireframe || m.flatShading || m.vertexColors) unsupported("material surface mode")` 拆开：
  - `wireframe` 保持拒绝（文案收敛为 `material wireframe`）。
  - `flatShading`/`vertexColors`：缺省（undefined，如 MeshBasicMaterial 无 flatShading 字段）
    等价于未请求；提供时必须为布尔，否则 invalid。
  - `vertexColors=true` 而几何无 color attribute → 投影桥 invalid（fail-closed）。
  - `flatShading=true` 且材质带 normalTexture → 暂时 unsupported（组合派生留待后续切片）。
  - 缺颜色分量（itemSize 非 3/4）、NaN/Inf 颜色、退化输入 → 一律拒绝。
- colors 打包由材质请求驱动：同一源几何可同时服务 vertexColors=true/false 材质，
  分别派生为带/不带颜色流的两个资源（`/color` 后缀隔离），旧无颜色路径形状不变。

## 链路

- **Three**：geometryView 读 `attributes.color`（itemSize 3|4，int 归一化沿用 component()）；
  projectGeometry 打包 colors（finite 校验、3 分量补 alpha=1）、normalMapped 压紧时搬运 colors、
  flatten 在压紧之后应用（flat+normalMap 组合已在桥内拒绝，互斥成立）。
- **packet 校验/预算**：validateGeometries 校验 colors 布局（长度=顶点数×4、finite）；
  geometryGpuByteLength 计入 colors 16B/顶点；runtimePackage JSON 白名单加 `colors`（往返保真）。
- **Web**：MeshBuffers 上传独立颜色 buffer 并在 draw 各路径绑定 slot4——现行 pipeline 未声明
  该 slot 的属性输入，shader 采样在颜色变体切片接入；旧无颜色几何不产生该 buffer。
  residency/快照族（loader/snapshot/catalog/projectionView/staging 相等性/bake hash）全部同步，
  颜色变化会正确触发重上传，不静默丢流。
- **Native**：contract serde 接受 `colors`（deny_unknown_fields 下旧包照常）；validate_geometry
  校验布局；`pack_color_vertices` 打包独立顶点 buffer；GpuGeometry 持有 color_buffer。
  **无颜色流时不产生颜色 buffer，旧上传序列与旧 ABI 逐字节一致（硬验收）。**

## 测试与证据

- TS：`flatGeometry.test.ts` 7 项（绕序面法线/共享 indexed 面展开/镜像翻转/烘焙非均匀缩放
  单位法线/uv+colors 搬运/退化拒绝/越界+切线拒绝）；`ThreeProjectionBridge.vertexColors.test.ts`
  11 项（3|4 分量打包与 features 声明/旧路径无 colors 字段/无颜色流拒绝/NaN 与 itemSize 拒绝/
  flat 非索引+面法线+方向一致/flat+normalMap 拒绝/共享几何隔离/mirrored 正交/JSON 往返）；
  `shaderAbiV4.test.ts` 2 项（v1/v2/v3 golden 保持 + v4 SHA256 自洽 + 结构钉死）。
- Native：`contract_color_stream_tests.rs` 4 项（旧包无 colors 解析校验不变/colors 往返/
  长度错拒绝/非有限拒绝）；mesh_abi 内嵌 3 项（ABI 常量冻结/无颜色流缺席/逐顶点往返）。
- 门禁：`cargo fmt --check` 通过；`cargo clippy -D warnings`（all-targets/all-features）通过；
  `cargo test --locked --lib` **282 passed / 0 failed**（基线 275 + 新增 7）；
  deep-engine typecheck 通过；deep-engine 全量 vitest 除既有 sourceSizeGate 失败外全绿
  （失败 7 个文件均为历史文件：deep2d_gpu_cache.rs 320 行、cli.rs 316 行、performance_guards.rs 313 行等，
  本切片新文件最大 268 行）。

## 边界（如实）

- **glTF COLOR_0 解码未接**：`gltf/meshResources.ts` 与 `accessors.ts` 仍拒绝 COLOR_0
  （normalized accessor 语义需要单独解冻）。glTF 侧接入是下一子步；本切片冻结的 ABI 即其目标合同。
- **shader 未采样颜色**：Web/Native 渲染管线尚未消费颜色流（Web 绑 slot4、Native color_buffer
  已就绪），彩色几何的像素级上屏与「彩色 BIM」通过标准由颜色变体切片完成；
  本切片通过标准中「flat 法线正背面一致」以派生层镜像/绕序用例覆盖，非 GPU 像素证据（GPU 测试被禁）。
- **flat+normalMap 组合**拒绝是显式过渡语义，解禁时需同时打通「压紧+flatten 复合派生」。
- 依赖：C01/B01 第一切片（unlit/fog 工作区状态）之上开发，未回退其任何行为。
