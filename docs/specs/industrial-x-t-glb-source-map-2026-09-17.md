# X_T 源面到 GLB 图元映射

研究转换链已保留源 BODY/FACE 到最终三角形区间的映射，109 件真实样本通过映射覆盖与独立源计数核验。仍为预览证据，不新增生产 profile。

## 实现

复用 `Scene` 的 GeometryId，附加轻量源身份表。离散器已有的面区间在材质排序后绑定索引指纹，GLB 写出时沿现有 16-bit 图元分块裁切区间。没有拆成逐面 draw call，没有复制场景或增加顶点属性。

每个 primitive 的 `extras.bimSourceMap` 使用 v1 合同：`scope=source-file-local`、`format=X_T`、BODY 字符串句柄、`faceRanges=[局部三角起点,三角数量,FACE字符串句柄]`。源文件 SHA-256 由独立证据文件绑定；句柄本身不是跨文件唯一身份。

写出前检查源句柄、面区间完整覆盖、材质区间与三角对齐。FNV-1a 索引指纹只检测意外索引重排，不是密码学身份认证，也不保护原地修改顶点或源身份表。分块通过二分定位首区间，再线性扫描相交面。

## 验证

- `cad-ir` 149、`cad-export` 39、`cad-xt` 15 项测试通过。新增测试覆盖区间缺口、越界、索引修改、材质遗漏，以及同一源面跨 65535 索引分块；plain/lean/compact 的映射与重复导出一致。
- Rust glTF reader 仅验证 plain 模式；其不支持 `KHR_mesh_quantization`，量化模式此处只检查映射与确定性，不计为第三方几何解码验收。
- Node 映射与源计数聚焦 6 项通过；109/109 新 GLB 通过产品几何审核、源 BODY/FACE 数量对拍和 primitive 三角覆盖审核。
- 最小补丁反向检查通过。缺少锁定开发依赖时已执行 `cargo fetch --locked`，随后离线测试成功，未修改依赖版本。

计数与区间自洽不足以证明面身份正确。独立 RAW BODY→FACE 集合核验在下一切片补充；即使集合一致，同一 BODY 内互换 FACE 标签仍需三角几何对应测试辨别。曲面误差、单位、闭合性、装配实例及产品接线继续待办。

## 工件与复现

补丁 [cadconvert-xt-source-map.patch](../../scripts/fixtures/cadconvert-xt-source-map.patch) 接在已有 decode、距离、shell 与 isolated-loop 补丁之后，基于研究提交 `73b37836a55f905ea0f392cf676dff160c745287`。未把研究源码或 CAD 样本纳入产品依赖。

```powershell
pnpm exec tsx scripts/verify-xt-native-corpus.mts data/external-assets/format-research/cadconvert/native/target/release/cadconvert.exe data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges-inventory.json test-output/xt-native-mapped
node scripts/audit-xt-glb-source-maps.mjs test-output/xt-native-mapped/evidence.json test-output/xt-glb-source-maps.json
node scripts/audit-xt-source-counts.mjs test-output/xt-research-source-counts/report.tsv test-output/xt-native-mapped/evidence.json test-output/xt-mapped-source-count-comparison.json
```

本地证据 SHA-256：

| 工件 | SHA-256 |
| --- | --- |
| release CLI | `27a0a19dbc89a6791c4ed2eb76acb307b6dbc37f5ecb0479c4911f002b6b26ac` |
| native-mapped/evidence.json | `db29e332af636854a77032389265c5d8a9de2db109f4bbbabaedfe88f1989444` |
| xt-glb-source-maps.json | `a28c514a570ce8d1bc6f0de39d0247595148b02352f1fa4f20a9cb0fddcbae32` |
| xt-mapped-source-count-comparison.json | `9e81aca43046d2f8b79d7f3223377179d265b748fcfb0b16d970b9229f048693` |
