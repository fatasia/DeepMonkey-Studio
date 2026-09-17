# DE26/C03 第一切片 · 透明与双面状态保真（合同冻结 + Three/Web/Native 对拍）

> 2026-09-17 后续更新：Native 生产管线和浏览器生产 Weighted OIT 的真实 GPU 像素读回均已完成；
> 浏览器完整 renderPacket→PBR flags/镜像批次与作者发布链仍未覆盖，因此 C03 整卡保持进行中。

日期：2026-09-17。卡：DE26/C03（P1）。范围：透明语义三字段显式化、materials.ts 解除一刀切拒绝、
weighted OIT premultiplied 语义修正、Native premultiplied blend 变体、旧包/旧上传序列不变。
跟随 DE26/C02 的拆解模式（缺省=未请求，提供必须校验；矩阵内接受并投影，矩阵外 fail-closed）。

## 冻结内容：透明语义支持矩阵

材质描述显式字段（packet `PbrMaterial`）与缺省语义：

| 字段 | 类型 | 缺省 | 合法域 |
|---|---|---|---|
| `alphaMode` | `"OPAQUE"\|"MASK"\|"BLEND"` | `"OPAQUE"` | 单值枚举——**MASK 与 BLEND 互斥**，不存在同时声明 |
| `premultipliedAlpha` | `boolean`（新增） | `false`（=straight） | **仅 `alphaMode="BLEND"` 合法**；OPAQUE/MASK 声明 → 两端 validate fail-closed |
| `doubleSided` | `boolean` | `false` | true 时关闭背面剔除并在背面光照前翻转法线 |
| `baseColorAlpha` | `number` | `1` | **零 alpha 合法**：BLEND 等价完全不可见（仍绘制、不剔除、不拒绝），供动画 alpha 使用 |

两端渲染语义（Web `transparencySupportMatrix` 与 Native `BlendSemantic` 逐项对拍）：

| 维度 | straight（缺省） | premultiplied | 声明源 |
|---|---|---|---|
| blend RGB | `src-alpha / one-minus-src-alpha` | `one / one-minus-src-alpha` | pipelines.ts 矩阵 = Native blend_state |
| blend alpha | `one / one-minus-src-alpha` | 同左 | 同上 |
| depthWrite | **恒 false**（Web OIT 累积 pass 与 Native 排序 blend 均不写深度） | 同左 | OPAQUE/MASK 才写深度 |
| side | `front`/`double` 支持（double=cull none 单 pass）；`back` 矩阵外 | 同左 | 桥 `ProjectedMaterial.side` 显式化 |
| 阴影 | **BLEND 不进 shadow pass**（Web `shadowMode()→undefined`；Native `draw_shadow_indirect` 排除 Blend） | 同左 | MASK 以 alphaCutoff 参与 mask 阴影，OPAQUE 为 solid |
| 排序 | weighted OIT：累积可交换，**与绘制次序无关**（浮点舍入级差异内） | 同左 | Native：同帧按 sort_center 视深 back-to-front，`stable_order` 决胜，帧内确定 |

**premultiplied 预乘不变式**：作者 RGB 必须满足 `C' = C·a`（零 alpha 的规范编码 RGB 必为 0）。
Web OIT premultiplied 累积分支不二次乘 alpha：`accum.rgb += C'·w`；合成公式不变——
`Σ(C·a)w / Σ(a·w)` 恰为 straight 空间按 `a·w` 加权的平均颜色，数学上与 straight 路径同构。

**双面玻璃（three.js two-pass 折叠）**：`BLEND + DoubleSide + forceSinglePass=false` 不再拒绝。
weighted OIT 累积满足交换律，three.js 的「先背面后正面 two-pass」声明折叠为
单 pass cull-none 数学等价；`forceSinglePass` 只要求布尔（缺省视为已声明单 pass 语义）。

**阴影参与（显式声明）**：透明物不投影阴影是第一切片的合同而非实现缺口；
`shadowSide` 每材质阴影面选择维持拒绝（两端均无该语义槽位）。

## 拒绝语义（threeBridge/materials.ts）

- `m.premultipliedAlpha`：缺省=未请求；非布尔 → invalid；桥只投影 `true`，`true`+非 BLEND → unsupported
  `material.premultipliedAlpha`（Three 默认 `false` 不写入 packet）；packet 合同中 OPAQUE/MASK 显式声明
  `false` 或 `true` 均 fail-closed，BLEND 显式 `false` 等价 straight。
- `m.side=BackSide`：保持 unsupported `material.BackSide`（矩阵外）。
- `BLEND + m.depthWrite !== false`：保持 unsupported `material transparent depthWrite`
  （作者请求写深度时 fail-closed，不静默丢设置；挖孔用 MASK）。
- `BLEND + DoubleSide` two-pass 拒绝**解除**（见上）。
- `ProjectedMaterial` 新增显式字段 `side: "front"|"back"|"double"`、`depthWrite: boolean`
  （OPAQUE/MASK 恒 true，BLEND 恒 false），供投影侧状态对拍。

## 链路

- **packet**：`PbrMaterial.premultipliedAlpha?` 进类型与 runtimePackage JSON 白名单（往返保真）；
  `renderPacketMaterials` 校验（布尔 + 仅 BLEND）；`renderPacketBatches` 打包 flags **bit128**
  （位图与 Native `surface_flags` 逐位对拍：1 double / 2 mask / 4 blend / +2 blend-cutoff /
  16 不接收阴影 / 32 fog off / 64 unlit / **128 premultiplied**）；batch key 以条件后缀
  `/premultiplied` 隔离混合公式——缺省 straight 的旧包 key 字节不变；
  `assetBakePlan` 材质变体身份仅在 BLEND+premultiplied 时追加段（旧包 hash 不变）。
- **Web**：`weightedOitWgsl` 新增 `deepWeightedOitPremultiplied`（累积不二次乘 alpha）；
  `pbrShader` 两个透明入口按 `flag(material.w, 128u)` select 累积分支；
  `pipelines.ts` 冻结 `transparencySupportMatrix`（straight/premultiplied blend 因子、
  depthWrite false、shadow none、supportedSides、zeroAlpha 语义），`alphaBlendSemantics`
  成为矩阵的 straight 视图。
- **Native**：contract serde 接受 `premultipliedAlpha`（deny_unknown_fields 下旧包照常解析）；
  `validate_packet` 拒绝非 BLEND 的 premultiplied；`scene.rs` BatchKey/DrawBatch 携带
  `premultiplied`；`surface_flags` 输出 bit128；`pipeline/mesh.rs` 以 `BlendSemantic`
  （Solid/Straight/Premultiplied）建管线，premultiplied RGB 因子为 `one`，两种透明语义均不写深度；
  `MESH_PIPELINE_VARIANTS` 12→18（solid 6 + straight-blend 6 + premultiplied-blend 6），
  GPU 探针断言同步；`gpu_scene_draw.bind_color` 按批选择变体。排序/阴影参与逻辑不变（已合规）。

## 测试与证据

- TS：`ThreeProjectionBridge.transparency.test.ts` 10 项（双面玻璃接受与 two-pass 折叠/
  重叠+交叉玻璃单批 OIT/镜像玻璃背面可见不翻转批/premultiplied 批身份隔离/材质仅变换更新
  与发布 JSON 往返保真/实例 flags 位图/MASK-BLEND 单值互斥/零 alpha 往返/矩阵外 fail-closed
  四连/阴影参与声明）；`weightedOitBlendSemantics.test.ts` 6 项（次序交换律到 1e-12、零 alpha
  完全不可见、premultiplied≡straight 累积逐位、WGSL 入口与矩阵对拍、混合公式批隔离）；
  `pbrShader.test.ts` 透明入口断言随新合同更新（两入口 × select 分发 + alpha 提取行）；
  `ThreeProjectionBridge.test.ts` 删除被解除的 two-pass 拒绝断言（行为由新文件覆盖）。
- Native：`contract/contract_transparency_tests.rs` 6 项（旧包无字段解析校验不变/premultiplied
  往返+batch+flags 128/非 BLEND fail-closed/显式 false=缺省 straight/straight 与 premultiplied
  不并批且逐 BLEND 实例独立批/排序同帧确定 + back-to-front）。`cargo test --locked --lib`
  **288 passed / 0 failed**（基线 282 + 新增 6）。
- 门禁：`cargo fmt --check` 通过；`cargo check --locked --all-targets --all-features` 通过；
  `cargo clippy --locked --all-targets --all-features -D warnings` 通过；Native lib 288/0/1 ignored，
  `alpha_pipeline` 7/7；deep-engine typecheck 通过，聚焦 50/2 skipped，全 src 2910/41 skipped；
  runtime purity 通过。deep-engine 全量链仅既有 sourceSizeGate 7 项历史违规失败（非本切片文件），
  本切片新文件最大 295 行（≤400 红线）。

## 边界（如实）

- **浏览器完整 PBR/packet 纵向像素仍缺失**：浏览器生产 Weighted OIT 已完成真实硬件两轮和
  全帧像素对拍，但夹具直接调用生产 OIT WGSL/targets/composite，仅自备矩形顶点与函数入口。
  renderPacket→PBR shader bit128、镜像实例批次和作者发布链仍是 C03 的剩余验收项。
- **`side=back` 仍矩阵外**：桥显式拒绝；解除需在批/管线键引入第三 raster 态（ccw/cw 折叠），
  留待下一子切片。
- **`BLEND + depthWrite=true` 仍全端拒绝**：weighted OIT 合同不写深度；如需「写深度的透明」
  （水面类）须独立管线与帧图声明，是显式的后续切片而非本合同缺口。
- **premultiplied 光照语义**：引擎以作者数据空间直接混合（管线层 one 因子 / OIT 不二次乘），
  不做 premultiplied 光照物理校正；输入违反预乘不变式时零 alpha 片元可能残留颜色贡献（合同
  允许的未定义域）。
- Native `alpha_summary`/遥测未新增 premultiplied 计数（避免触碰序列化面）；管线变体数已同步
  全部消费点（app 探针、content profile）。

## 第二切片：Native 生产管线 GPU 像素证据

测试直接调用生产 `gpu_scene_draw`、材质 shader 与 mesh pipeline，不另写测试混合器：

- straight `[0.8, 0.4, 0.2] × 0.5` 与 premultiplied `[0.4, 0.2, 0.1] × 0.5`
  的完整 256×256 RGBA16F framebuffer 逐字节相同；实际覆盖 11,236 像素。
- straight 零 alpha 与透明清屏逐字节相同，防止 RGB 泄漏。
- 单面正/反绕序只有一侧可见，覆盖计数 `[11236, 0]`；双面正/反绕序都可见且 framebuffer
  逐字节相同，证明真实 raster cull 状态而非只检查管线描述。
- NVIDIA GeForce RTX 4060 Laptop GPU、Vulkan、驱动 595.79 连续执行两轮均通过；两份
  PPM 均为 196,623 bytes，SHA-256 都是
  `5c045ebc6766cfab3c95ff051a4119f808b4cb0d9b3d0f236875af1a1bc36e57`。
- 主线程将 PPM 转为 PNG 并实际查看：深灰清屏上的单一半透明暖色方片，边界完整、无遮罩泄漏。
  这是语义诊断图，不是产品界面视觉稿；本片未新增颜色、样式或设计令牌，也不据此宣称
  Kimi-95 产品视觉闭环完成。

聚焦回归：本测试文件 21 passed / 3 个显式 real-GPU ignored；新增用例单独 `--ignored --exact`
连续两轮 1/1；test clippy `-D warnings` 与 crate fmt 通过。证据图片位于 gitignored 的
`test-output/de26-c03/`，代码只在设置 `DEEP_C03_EVIDENCE_PPM` 时写出，不污染正常测试。
