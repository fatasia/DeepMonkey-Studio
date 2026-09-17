# 3DM 源法线、UV 与纹理身份

已把真实 3DM 保存的顶点法线和纹理坐标传入 GLB，并逐项核对序列化后的二进制数据。材质/纹理仍为可追溯源身份，不是完整外观转换。

## 源证据与最小实现

上一版 JSON 只有位置、三角索引和材质身份。新增字段直接读取 openNURBS `ON_Mesh.m_N`、`ON_Mesh.m_T`；非空属性的长度必须等于源顶点数。`m_S` 在官方头文件中可能是曲面参数，仅输出其计数，不冒充 UV。没有保存法线/UV 时不生成替代数据。

`ON_Material.m_textures` 直接保留纹理 UUID、类型、enabled、mapping channel、原始 full/relative path、wrapU/V 和 UVW 矩阵；材质保留原始 legacy diffuse RGB，不将其猜成 glTF PBR 参数。GLB 根节点 extras 和 sidecar 都保存源材质表；没有生成 image/texture/material 资源，也不会读取源路径或发起网络请求。

真实 `meshWithTexture.3dm` 的对象 UUID 为 `c199bcce-56b8-4dcf-afe8-2e9286ed73e6`，材质来源为 object、索引 0，材质 UUID `8fd80634-47e8-4e76-bb17-cddbdfbdc648`，纹理 UUID `0af451f3-18cf-4b6b-a7a8-27368ad7ba45`。其 mapping channel `4294967283 / 0xfffffff3` 对应上游 `ON_Texture::MAPPING_CHANNEL::wcs_box_channel`，不是已证明可直接采样的普通 UV。原纹理路径指向作者 macOS Rhino 应用目录的 `bump_grit.png`；它只是源元数据，不是本工具运行依赖。不能把保存的 `m_T` + 路径当作完整纹理显示证据。

## 验证结果

样本来源和 SHA 沿用 [源读取实验](industrial-3dm-source-audit-2026-09-17.md)，原件未变化。读取器重建仍只使用已有 MSVC/openNURBS，无新依赖或上游源码改动。

| 样本 | 法线 | UV | GLB 字节 | 顶点 / 三角形 |
|---|---:|---:|---:|---:|
| mesh.3dm | 420 | 420 | 18,868 | 420 / 276 |
| meshWithTexture.3dm | 92 | 92 | 7,664 | 92 / 180 |
| blocks.3dm | 0 | 0 | 不输出 | 0 / 0 |

- 3 个真实源读取/hash/重复输出/截断拒绝回归通过，正常 stderr 为空。
- 两份 GLB 通过产品 `auditGlbGeometry`，位置、索引、NORMAL、TEXCOORD_0 全部逐元素对拍。新增属性使 writer 采用交错顶点布局，审计已按真实 bufferView.byteStride + accessor.byteOffset 读取，不能再假设连续属性数组。
- 7 项研究测试通过，覆盖属性存在/缺失、长度不匹配、非有限值、非单位/零法线、未证明 UV 来源拒绝，以及原有实例共享/变换、循环和缺几何行为。
- 产品 `converterOutputAudit.test.ts` 10 项回归通过。
- 扩展纹理路径字段时发现空 ON_String 的 Array() 可返回 nullptr，JSON 字符串函数已显式映射为空字符串；真实空 relativePath 回归通过。

当前读取器 SHA-256 为 `d73b3392ff3eefd092e7a97fd32c8ce86f0078dbb3a4c12c7f399fa6ff3c6a9f`；mesh GLB 为 `87223017589ec5f4aa8b37919ef4a1227857a194282e9499ecd9660d095af398`；meshWithTexture GLB 为 `39b578b2306b8c33972c8292caf97dbe50069b689aa1af583978949262c7060b`。

复现命令与上片相同：先运行 `build-3dm-source-audit.cmd`、`audit-3dm-source.mjs`，再运行带 tsx loader 的 `3dm-glb-export.test.mts` 和 `audit-3dm-glb.mts`。证据仍在 gitignored `test-output/3dm-source-audit/evidence.json` 与 `glb-evidence.json`，旧报告 hash 是对应历史阶段，不应当作当前产物 hash。

## 边界

UV 当前是原始保存值的无损 Float32 传递；没有纹理像素、采样方向或 WCS 投影外观承诺。PBR 映射、嵌入图片、真实带网格实例的外观和 Deep Engine 视觉验收仍待后续切片。没有产品依赖/路由/共享总账改动，未提高产品格式能力等级。
