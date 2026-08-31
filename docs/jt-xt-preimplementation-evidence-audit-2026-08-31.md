# JT / Parasolid X_T 开发前证据审计（2026-08-31）

## 结论

当前项目**没有 JT 或 Parasolid X_T/X_B 几何读取能力**。已有的是安全的有限结构探测、上传/等待 Provider 状态机和外部转换产物审计，不等于几何转换。

- JT 可以基于 Siemens 公开规范自研“装配树 + 已三角化 LOD”子集，但完整解码是数月级工程；精确 XT B-Rep 、全 PMI 和所有历史版本不应进入首版。
- X_T 实用自研子集应限定为**文本 X_T 读取**，而非 X_B/写回。MIT/Apache 候选已证明路径可行，但尚有许可元数据、专有材质资产和部署架构风险，不能原样并入。
- 本次仅修复了真实 X_T 样本暴露的结构探测缺口：能识别紧凑 `T51` identification 和三段 schema key，仍固定返回 `geometryParsed: false`。
- 本文不更改产品能力状态；JT/X_T/X_B 未配置真实 Provider 时仍是 `waiting_converter`。

## 证据等级

| 等级 | 含义 | 当前 JT | 当前 X_T |
| --- | --- | --- | --- |
| L0 声明 | 扩展名/入口存在 | 有 | 有 |
| L1 结构 | 真实样本的头、版本、TOC/schema 可识别 | 有（JT 10.3 TOC） | 有（SolidWorks PS 24.1 头/schema） |
| L2 几何 | 源文件真实几何可读取并有对照 | 无 | 项目无；外部候选单样本实验通过 |
| L3 生产 | 版本/几何/故障语料、许可和发布门禁闭环 | 无 | 无 |

## 项目与本机实际能力

### 依赖与 Three.js

- API 的 `occt-import-js@0.0.23` 用于 STEP；Web 的 `replicad`/OpenCascade WASM 也没有 JT/Parasolid 商业读取器。
- Web 使用 `three@0.185.1`。本地 `examples/jsm/loaders` 有 `USDLoader`/`USDZLoader` 和常见网格 loader，无 `JTLoader` 或 Parasolid loader。
- Python 环境未安装 OCC/JT/Parasolid/CAD 读取包。Unity smoke 工程仅含自研 bridge 和 uGUI，无 Pixyz/Asset Transformer/JT 包。

### 已安装软件

| 软件 | 所见能力 | 能否作为产品转换后端 |
| --- | --- | --- |
| CAD Assistant 1.6.0 | 二进制包含 `RWCADMesh_JtReader`/`JtData_Model` 和 Parasolid XT 入口 | 否。[Open Cascade 官方](https://www.opencascade.com/products/cad-assistant/) 明确 JT/Parasolid 由商业 XDE 组件提供，且此类导入模型禁止导出/转换。 |
| FreeCAD 1.1 | 安装目录有 STEP/IGES/glTF/OBJ 等 TKDE DLL | 否。未发现 TKJT/Parasolid DLL。 |
| Creo Parametric 9 | 安装资源中可见 `INTF_for_JT` 和 Parasolid 功能标识 | 未证实。当前许可诊断不能证明功能可运行；即使可用也是商业桌面依赖，不可再分发。 |

## 现有代码的真实边界

- [`jtStructureProbe.ts`](../apps/api/src/jtStructureProbe.ts) 只解析 80/109 字节固定头、字节序、TOC offset 与 entry count；不读 Segment/LSG/LOD/几何/装配/PMI。
- [`xtStructureProbe.ts`](../apps/api/src/xtStructureProbe.ts) 只读传输头、T/B/PS 标记、modeller/schema identification；不读 B-Rep、NURBS、trim 或 heal。
- [`industrialFormatProbe.ts`](../apps/api/src/industrialFormatProbe.ts) 仅限量读取磁盘样本并调用上述探测器。
- [`conversion.ts`](../apps/api/src/conversion.ts) 对 JT/X_T/X_B 只能执行 `INDUSTRIAL_CAD_CONVERTER_COMMAND`；未配置则进入 `waiting_converter`。
- [`converterOutputAudit.ts`](../apps/api/src/converterOutputAudit.ts) 验证外部程序产出的 GLB 确有三角网格，并检查 JSON sidecar。它不能证明 GLB 来自源 JT/X_T。
- `jtStructureProbe.test.ts`/`xtStructureProbe.test.ts` 原为合成字节；`industrialFormatWaitingAcceptance.test.ts` 与 `externalConverterCatalog.test.ts` 的 fake converter 输出固定三角形，只验证管线。

## 真实样本与实测

样本位于 `data/external-assets/format-fixtures/`，源文件、许可和 SHA-256 详见同目录 `manifest.json`。`data/` 当前被 gitignore，因此真实样本未提交到产品代码。

| 样本 | 来源/许可 | 大小 | SHA-256 |
| --- | --- | ---: | --- |
| `voyager-example-block-jt10.3.jt` | [Voyager 固定 commit 样本](https://github.com/TobiasMusin/Voyager/blob/cab6307021b72c5328a66c93cdc8f3bde6b12549/src/main/resources/example_block_jt10.3.jt) / [Apache-2.0](https://github.com/TobiasMusin/Voyager/blob/cab6307021b72c5328a66c93cdc8f3bde6b12549/LICENCE) | 10,330 B | `937a7c41559f9c9cb7f69b3d981b171cbadee417ab1e4f5bcb21b122728403f4` |
| `cadconvert-small.x_t` | [CadConvert 固定 commit 样本](https://github.com/omerbasavul/cadconvert/blob/73b37836a55f905ea0f392cf676dff160c745287/native/crates/cad-convert/tests/samples/small.x_t) / [根目录 MIT](https://github.com/omerbasavul/cadconvert/blob/73b37836a55f905ea0f392cf676dff160c745287/LICENSE) | 6,207 B | `4a6c8c8e5b0a5f2b3674d2f3d15248512bdc19501fe42056374ee4c78b0f387f` |

观测结果：

1. JT 样本被识别为 10.3 little-endian，TOC offset 109、9 entries；仍明确 `geometryParsed:false`。
2. X_T 样本是 SolidWorks 2013 / Parasolid 24.1 文本件。初始实测暴露现有解析只支持合成的二段 schema；修复后可识别 `T51` 和 `SCH_2401231_20000_1300`，仍不读几何。
3. 未接入项目的 CadConvert commit `73b3783...` 在本机将该 X_T 实验转换为 GLB：1 body、10/10 faces、3,598 triangles。`plain` 输出通过项目 `auditGlbGeometry`（1 mesh、2,378 vertices、3,598 triangles）。这仅证明候选路径在一个样本上有效，不是项目 X_T 能力。
4. CadConvert 默认 `lean` GLB 要求 `KHR_mesh_quantization`，当前审计器未注册该扩展而拒绝；现有 industrial Provider 还要求 `hierarchy.json`。两者都是真实集成缺口。

## 官方规范与开源候选

| 项目/规范 | 许可与完成度 | 结论 |
| --- | --- | --- |
| [Siemens JT Open / V10.6](https://www.siemens.com/en-gb/products/plm-components/jt/jt-open-program/) | 规范允许编写/分发 JT 读写软件，需保留要求的版权通知；JTTK 为付费会员组件 | 规范可作自研一级依据；完整 Toolkit 不是无商业依赖路线。 |
| [OpenCascade JT-Assistant](https://github.com/Open-Cascade-SAS/JT-Assistant/tree/e859e8c2d809f9d9468e6211eba0052f433978ee) | GPL-2.0，停留在 2015；[OpenCascade 官方回复](https://dev.opencascade.org/content/jtteader-and-jt-assistant-license-change) 称旧公开 reader 已转商业且不再支持 | 可作行为/格式参考；闭源产品不可直接链接或拷贝。 |
| [jcadlib](https://github.com/liamsi/jcadlib/tree/27a12d1970e7684ef369d0a815aee0b7a194b02b) | Java 源文件逐文件 MIT，但仓库无根 LICENSE；2013 停更，末次 commit 因权利不明删除样本 | 可选择性参考/移植解码思路并保留单文件 MIT；不能当现代 JT 10.x 生产库。 |
| [Voyager](https://github.com/TobiasMusin/Voyager/tree/cab6307021b72c5328a66c93cdc8f3bde6b12549) | Apache-2.0；README 明示只能导出顶点位置，无面/索引/法线/材质/层级导出 | 可作 JT 10 结构参考和样本来源；不能直接作转换器。 |
| [akiselev/xt-parser](https://github.com/akiselev/xt-parser/tree/eced07bacc0ef7486690092d35816e8118486854) | Rust/WIP；Cargo 声明 Apache-2.0 但仓库无 LICENSE 文件 | 只作技术参考；获得作者许可确认前不直接发布。 |
| [parasolid-kit](https://github.com/monozukuri-ai/parasolid-kit/tree/a607219811fb39a10fddd8161726a53c250c6382) | MIT、pre-alpha、Python+Rust；完整解析必须由调用方提供与文件精确匹配的 Siemens schema catalog | 代码可研究，但“无商业/无外部 schema 依赖”不成立；不直接并入当前 TS 主链。 |
| [CadConvert](https://github.com/omerbasavul/cadconvert/tree/73b37836a55f905ea0f392cf676dff160c745287) | 根 LICENSE/README 称 MIT，Cargo workspace 却声明 Apache-2.0；实现 X_T→GLB，但仅为 2026 新项目 | 技术上是 X_T 最有价值候选；许可元数据必须先由作者澄清。仓库还捆绑 619 个来源于 SolidWorks 安装的 `.p2m` 外观文件，未见独立再分发许可，必须剔除/法务确认；不可原样入库。 |

[Siemens 官方](https://www.siemens.com/en-gb/products/plm-components/parasolid/data-access-translation/) 称 X_T 是开放、已发布的数据格式，但“格式已公布”不等于 Siemens schema catalog/Parasolid 内核也能自由再分发。

## 建议路线

### JT：先做可视化高价值子集

1. 以 Siemens V10.6/V10.0 规范为一级依据，先支持 monolithic JT 9.5/10.x：头、TOC、Segment、zlib/LZMA 封装、LSG 树与 transform。
2. 解码文件中已三角化的 TriStrip/TopoMesh LOD，输出 GLB + `hierarchy.json` + 可追溯 object id；默认保留最高 LOD，不降低用户可感知质量。
3. 对未支持 codec/element 明确拒绝而不猜测，实施长度、返回引用、压缩比、深度和内存限制。
4. 首版不做精确 XT B-Rep、完整 PMI、shattered/外部分区、JT writer 和 6.x–8.x 全变体。

估算：2 名熟悉二进制格式的工程师，4–8 周完成真实语料上的可视化 V1；达到多厂商/恶意文件生产门禁约 2–4 个月。

### X_T：限定 text-only，先证明许可与语料

1. 先向 CadConvert 作者确认 MIT/Apache 适用边界，完全移除 SolidWorks `.p2m`/材料库等权利不清资产；不引入 Rust sidecar，先作差分测试 oracle。
2. 自研模块只读 X_T：传输头/嵌入 schema、node stream，body/shell/face/loop/fin/edge/vertex 拓扑，直线/圆/平面/柱/锥/球/环面，再增加有界 B-spline/NURBS。
3. 将可重建的 B-Rep 送入项目已有 OCCT 进行高质量三角化，对 blend/intersection/foreign geometry 等未支持类型明确拒绝，不默默 heal/近似。
4. X_B（bare/typed/neutral binary）、通用 writer、特征树恢复和“全版本 Parasolid”暂不做。

估算：许可/语料门禁 1–2 周；限定分析几何 X_T V1 约 8–16 周；跨多版本复杂 NURBS/blend 的鲁棒读取是 6–12 个月级风险，不应承诺一次完整复刻 Parasolid。

## 可复现命令

```powershell
# 结构探测回归
pnpm --filter @bim-studio/api exec vitest run src/xtStructureProbe.test.ts src/industrialFormatProbe.test.ts

# 样本完整性
Get-FileHash -Algorithm SHA256 data/external-assets/format-fixtures/jt/voyager-example-block-jt10.3.jt
Get-FileHash -Algorithm SHA256 data/external-assets/format-fixtures/x_t/cadconvert-small.x_t

# 本地 Three.js loader 清单
Get-ChildItem apps/web/node_modules/three/examples/jsm/loaders -File | Select-Object -ExpandProperty Name
```

本次没有提交 JT/X_T 几何解析器、没有引入候选项目代码/商业二进制、没有把任何格式标记为“可用转换”。
