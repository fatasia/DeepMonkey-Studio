# N5-material-import 第三方 GLB unlit / 无 TANGENT profile 导入行为（2026-10-03）

行定义：「第三方 GLB unlit/无 TANGENT profile 的导入/生成/损失处理，避免零配置样板被拒；范围先核查」（4-8h）。
本文为进行中文档：现状核查已完成，夹具实测与最小补齐进行中。

2026-10-07更新：`advancedMaterials:true` 的导入路径现在保留 KHR_materials_specular 因子与两种贴图，经UV/变换、颜色空间、Browser packet和生产GPU消费。默认关闭能力时仍沿用本文的第三方profile fallback；unlit与非中性specular组合依然明确拒绝。真实SMT六张纹理/零导入loss、GPU静态+morph八项通过，见 [SMT高光贴图核查](studio-source-specular-audit-20261007.md)。本文下方矩阵是原profile基线，不是最新高级路径支持清单。

## 1. 现状核查（六步，2026-10-03 完成）

1. **全仓 grep**（packages/*/src、apps/*/src，含未跟踪文件）：`KHR_materials_unlit` 生产代码仅
   `gltf/optionalMaterialFallback.ts`（opt-in 投影）与 `shader/materialGltfMap.ts`（T08 fallback 清单）；
   `TANGENT` 生产代码在 `gltf/tangentSpace.ts`（生成/校验）、`gltf/meshResources.ts`、
   `gltf/textureManifest.ts`（requiresTangents）、`threeBridge/geometries.ts`（Three 桥）。
2. **契约层**：损失账本 = `gltf/capabilityInventory.ts`（DE26/C01 CapabilityFailure，code/stage/assetPath/detail/count）；
   `renderPacketTypes.ts` RenderPacket.materialLosses（author-only，不进 Native 运行包）。
   lossy-code 家族（T08 在册）：`material-invalid` / `material-value-invalid` / `material-texture-unsupported` /
   `extension-fallback` / `extension-unknown` / `material-profile-unsupported`。
3. **依赖**：纯 TS + vitest，零新依赖（切线生成为既有手写实现）。
4. **消费方**：
   - 生产链：`apps/web/src/delivery/compileSceneRenderPacket.ts:97` → `decodeTexturedGlb`，**未传
     optionalMaterialFallbacks**（零配置）。
   - 动画链：`gltf/decodeRuntimeGlb.ts:123,169` → `decodeTexturedGltfDocument`（同入口）。
   - lab：`lab/factoryWorkshop.ts`、`lab/modelPacket.ts`。
   - `pathTraceRenderPacketScene.ts:15` 对 packet.materialLosses 非空直接 throw（"unresolved material losses"），
     且 `apps/web/src/delivery/pathTraceAuthorPreparation.ts` 消费 compileSceneRenderPacket 产物 ——
     **场景级传播 materialLosses 会打破 CPU 路径追踪门**，本行不动场景编译器传播，见 §5 余项。
5. **测试与证据**：`decodeTexturedGlb.test.ts` 无 unlit/切线生成专项夹具（只有官方
   NormalTangentTest.glb 全链正例）；`decodeGltf.test.ts:100` 仅把 unlit 作为 extensionsUsed 拒绝样例之一；
   `tangentSpace.test.ts` 覆盖生成算法本身。第三方 profile 行为无夹具 → 真实缺口。
6. **规格**：`docs/specs/jc-i-continuation-20261001.md:259`（2026-10-02 02:45）称 N5 三项"全生产实现、实际为 0"
   ——但同段落上方 T12 刚发生"凭关键词盲区误判缺口已更正"事件；61 行表（2026-10-03，同文件 :614）已重开
   N5-material-import 实现行。**文档口径与代码不符，以本文夹具实测为准。**

## 2. 已有（不重建）

- 无 TANGENT + NORMAL + 法线纹理、UV 干净时：`attachManifest`（decodeTexturedGltf.ts:116-122）
  自动 `generateTangents` + `validateTangentBasis` —— 已生产实现，不重建。
- unlit/clearcoat **显式** opt-in 投影：`projectOptionalMaterialFallbacks`（optionalMaterialFallback.ts）。
- 损失账本合同与 lossy-code 家族（capabilityInventory + materialGltfMap）。
- 严格核心解码器 `decodeGltf`（无纹理子集，fail-closed 是其自身契约，本行不改）。

## 3. 真实缺口（代码走读结论，待夹具实证）

1. **零配置 unlit 必拒**：`extractGltfTextureManifest` → `validateExtensionSets`（textureManifest.ts:122-123）
   的 supported 集不含 KHR_materials_unlit，而 glTF 规范要求 unlit 声明进 extensionsUsed →
   任何带 unlit 的第三方 GLB 在 manifest 提取即抛 `unsupported extension`。opt-in 投影发生在
   manifest **之前**（decodeTexturedGltf.ts:155），故只有显式传参才可通过。生产消费方零配置 → 被拒。
2. **opt-in 投影静默丢语义**：投影删除 unlit 后，`mapGltfMaterialExtensions` 读的是投影后文档
   （decodeTexturedGltf.ts:164），unlit loss **一条都不记** → 违反"未知扩展不得静默丢弃"合同
   （静默转 lit PBR）。
3. **材料级 fallback 扩展必拒**：`readMaterialIor`（materialExtensions.ts:14-16）对不在
   SCALAR_MATERIAL_EXTENSIONS 的任何 material.extensions 条目直接 unsupported 抛错 ——
   unlit+specular/sheen/volume 等第三方常见组合即使 unlit 被投影，仍在材质面被拒；
   `mapGltfMaterialExtensions` 的 extension-fallback/extension-unknown loss 矩阵（T08 设计）
   实际永远到不了。
4. **未知非必需扩展必拒**：extensionsUsed 中的未知扩展（非 required，glTF 规范允许忽略）在
   manifest validateExtensionSets 抛错。extensionsRequired 未知扩展的拒绝是规范正确的，保留。
5. **切线不可交付时整体拒绝**：`generateTangents` 对镜像 UV 共享顶点/退化几何抛
   `invalid()`（tangentSpace.ts:33,43,47）；`validateTangentBasis` 对劣质 authored TANGENT 抛错
   （tangentSpace.ts:63,65,69，且 meshResources.ts:100 对普通材质也强校验）。
   第三方资产（镜像 UV 展开极常见）→ 整文件被拒，而非按损失合同降级。

## 4. 三态矩阵（实测后回填）

| 第三方 profile | 改前实测（P1-P10 夹具） | 改后实测 |
|---|---|---|
| unlit 含贴图，零配置（P1） | 拒：`extensionsUsed[0]: Unsupported extension KHR_materials_unlit` | 导入 + `extension-fallback@materials[0].extensions.KHR_materials_unlit` |
| unlit 无贴图，零配置（P2） | 同上被拒 | 导入 + 同 loss，材质回 core PBR 默认 |
| unlit + specular 组合（P4） | 同上被拒（首个 unsupported） | 导入 + 逐扩展两条 `extension-fallback` |
| 未知扩展非必需（P5） | 拒：`Unsupported extension ACME_weathering` | 导入 + `extension-unknown` |
| 未知扩展 / unlit 为 required（P6/P10） | 拒（正确） | 保持拒绝（fail-closed 规范正确，不变） |
| unlit 显式 opt-in（P3） | 通过、loss=[]（静默丢语义，违反合同） | 不变（调用方知情选择，保持 loss 静默） |
| 无 TANGENT + NORMAL + 法线纹理、UV 干净（P7） | 生成切线通过（tangents=16 floats） | 不变（已有能力，未重建） |
| 无 TANGENT + 镜像 UV（P8） | 拒：`Mirrored UV charts sharing a vertex require an authored TANGENT seam` | 降级：丢该材质法线贴图 + `material-normal-tangents-undeliverable`，资产可渲染 |
| 劣质 authored TANGENT（P9） | 拒：`TANGENT must contain unit XYZ...`（manifest 层 accessors[i]） | 降级：转几何生成；干净 UV 时生成成功、法线贴图保留（优于丢贴图）；生成亦失败才丢贴图并记 loss |

## 5. 实施记录（已完成）

- **切片 A（零配置投影 + 损失登记）**
  - `gltf/materialExtensions.ts`：新增 `DOCUMENT_SUPPORTED_EXTENSIONS`（textureManifest 与投影层共用，消除
    原 textureManifest 内联集合的漂移风险）与 `PROJECTABLE_FALLBACK_EXTENSIONS`
    （unlit/volume/dispersion/sheen/iridescence/specular；刻意排除 emissive_strength——gltf 层原生求值，
    排除 clearcoat/anisotropy/transmission/ior——属映射集）。
  - `gltf/optionalMaterialFallback.ts`：新增 `projectThirdPartyMaterialProfile`——非必需已知 fallback 与
    未知**材质级**扩展投影为核心 PBR 并逐条登记 `extension-fallback`/`extension-unknown`（T08 lossy-code
    家族复用，零新增码）；required 项原样保留由 manifest 精确拒绝；caller-owned 文档不修改。
  - `gltf/decodeTexturedGltf.ts`：`decodeTexturedGltfDocument` 在未提供 `optionalMaterialFallbacks` 时走
    默认投影；投影 loss 并入 `packet.materialLosses`。显式 opt-in 路径行为不变。
- **切片 B（切线降级 + 损失登记）**
  - `gltf/textureManifest.ts`：authored TANGENT 读取（`tangent4`）失败降级为无 authored 切线
    （仅 `GltfImportError` 容忍，其余错误照抛）；validateExtensionSets 改用共享 `DOCUMENT_SUPPORTED_EXTENSIONS`。
  - `gltf/decodeTexturedGltf.ts` `geometryDocument`：requiresTangents 图元剥离 TANGENT 属性
    （内层严格解码器不再整文件拒绝坏切线，切线改由 manifest 层供给/生成）。
  - `attachManifest`：生成/校验入 try 域（仅容忍 `GltfImportError`）；失败 → 几何不带 tangents + 该材质
    丢法线贴图 + loss `material-normal-tangents-undeliverable`（stage=material，assetPath 指向
    `materials[i].normalTexture`，detail 引用具体失败 primitive 与原因）；material/geometry 同步降级，
    `prepareRenderPacket` 的"法线贴图必须有切线基"一致性门（renderPacketGeometryFeatures）保持满足。
- **明确不做**：场景编译器（compileSceneRenderPacket）不传播 materialLosses——`pathTraceRenderPacketScene`
  对 materialLosses 非空直接 throw，而 `pathTraceAuthorPreparation`/`probeGridBakeRunner` 消费其产物，
  贸然传播会把降级资产场景的 CPU 路径追踪整体打破，属独立切片；`decodeGltf` 严格无纹理子集契约不变；
  无贴图材质的坏 authored TANGENT 仍按严格契约拒绝（引擎不消费该数据，但未纳入本行降级范围）。

## 6. 证据

- **改前行为**：临时探针（P1-P10，已删除）实测记录于 §4"改前实测"列，与代码走读（§3）一致。
- **正式夹具**：`packages/deep-engine/src/gltf/n5-material-profile.test.ts`（10 测试，Node 内拼字节最小 GLB，
  覆盖行定义要求的 unlit / 无 TANGENT 有 NORMAL / 无贴图 unlit / 未知扩展四类 + required 拒绝、opt-in
  静默、镜像 UV 降级、坏 authored TANGENT 生成恢复、`buildCapabilityInventory` 损失码词法合同、
  每条可渲染路径 `prepareRenderPacket` 门）。
- **测试结果**：
  - `src/gltf`：27 文件 259/259 通过（含本行新增 10 项与两处合同顺移更新）。
  - `@bim-studio/web src/delivery`（compileSceneRenderPacket 消费方）：91 文件 840/840 通过。
  - `@bim-studio/deep-engine` 全套：5962 通过 / 10 失败 / 51 skipped。10 个失败全部位于
    `lab/c8F32Inputs`、`lab/j3DFullLayerMatrix`、`lighting/iesSamplingWgslChecksum`、
    `shadows/cascadedShadowMathWgslChecksum`——四个文件对本行改动模块 **import 为零**（grep 实证），
    且所在域存在大量他线今日未提交改动（git log 顶部 78e75379 即 J3 WGSL checksum pin），失败内容为
    WGSL 字节比对与证据目录存在性，判定为他线域预存失败，与本行无耦合。
- **typecheck**：`deep-engine` `tsc --noEmit` 通过。
- **合同顺移**（行为变更的既有测试更新，同族排查后仅两处）：
  - `textureManifest.test.ts`：坏 authored TANGENT 由"manifest 必抛"改为"容忍降级（tangents 置空）"。
  - `textureTransformMultiAsset.test.ts`：官方 TextureTransformMultiTest（含 unlit）由"零配置必拒"改为
    "零配置导入 + unlit extension-fallback loss"；显式回退与 required 拒绝断言不变。
- **过程缺陷如实登记**：切片 A 首版为修 tsc 的 `result.extensionsUsed`（JsonObject unknown 索引）改写为
  条件展开 `{ ...document, ...(retainedUsed.length ? {...} : {}) }`，空数组分支把浅拷贝中的**原始**
  extensionsUsed 留在投影结果上，导致 5 项投影测试回退为改前拒绝行为；经最小 debug 夹具定位后改回
  无条件覆盖 + 空时 delete，并补 debug 实证（投影输出 DOC/LOSSES）后恢复全绿。

## 7. 完成度与未验证项（诚实声明）

- **已完成**：行定义全部刀口——unlit/无 TANGENT/无贴图 unlit/未知扩展四类 profile 的导入三态对齐损失
  合同；零配置不被拒；损失码逐条如实登记（复用 T08 家族 5 码 + 新增 1 码
  `material-normal-tangents-undeliverable`）；无新增 UI；未触碰禁改文件（physics、apps/web ai|hooks|
  RendererDiagnosticsPanel、editorSnapshotFetchBridge 均未修改）；未 commit/push。
- **未验证 / 边界**：
  1. 未在浏览器跑视觉闭环（本行为导入链行为合同，非视觉产出；unlit→lit PBR 的观感差异已由 loss detail
     声明，视觉验收属渲染域任务）。
  2. 场景编译器 materialLosses 传播未做（原因见 §5"明确不做"），场景级损失可见性仍是缺口。
  3. 无贴图材质 + 坏 authored TANGENT 仍整文件拒绝（严格子集契约，未纳入降级）。
  4. unlit 投影后的渲染结果为 lit PBR（引擎标量 profile 无 unlit 着色路径），语义降级已登记但视觉等价
     未提供。
  5. deep-engine 全套 10 个失败为本机他线域预存失败（零 import 关联），未修复（非本行义务，且修复会
     触碰他线未提交产出）。
  6. 动画链（decodeAnimatedMorphSkinnedGlb → validateAnimationDocument）对 extensionsUsed 任何声明整体
     unsupported，属既有文档级契约（改前同样拒绝带 unlit 声明的动画资产）；本行切片作用于
     decodeTexturedGltfDocument 材质/纹理面，未改动画层契约——带扩展声明的动画资产零配置导入是独立余项。
- **估时**：行定义 4-8h；实际以核查+夹具+双切片+回归完成，中途一次自引回归（§6 过程缺陷）已闭环。
