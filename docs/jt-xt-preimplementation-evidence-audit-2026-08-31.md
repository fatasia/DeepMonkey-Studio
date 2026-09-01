# JT / Parasolid X_T 开发前证据审计（2026-08-31）

## 结论

当前项目已新增两个**严格受限、真实样本验证的可视子集**：Parasolid X_T V24.1 文本旋转体，以及 JT 9.5/10 小端 TriStrip/TopoMesh v1 的最高精度 LOD0。JT 同时保留 TOC、LSG 装配层级、属性、材质和全部已识别 LOD 的检查证据；X_B 仍只有结构探测和外部 Provider 路径。任何结构读取都不能冒充可浏览几何。

- JT 可以基于 Siemens 公开规范自研“装配树 + 已三角化 LOD”子集，但完整解码是数月级工程；精确 XT B-Rep 、全 PMI 和所有历史版本不应进入首版。
- X_T 自研实现限定为 `SCH_2401231_20000_1300`、单 body、共轴封闭旋转体，以及圆/平面/柱/锥/单个圆环过渡的已签署组合。命中时输出 GLB、10 面选择层级和可读属性；其他有效文本版本只保存检查证据并停在 `waiting_converter`，不生成替代几何。
- `xtStructureProbe.ts` 仍只负责头部探测并固定返回 `geometryParsed:false`；真正几何证据由独立 `xtTextSubsetParser` / `xtRevolvedMesh` / `xtTextSubsetConverter` 链路产生，避免混淆探测与转换。
- `xtTextInspection.ts` 在探测器与几何子集之间形成能力检查层：跨 schema 读取版本与有界文件头元数据，并逐项声明 body/face/shell/装配、名称、颜色和属性绑定是否真正解码。
- JT 上传后先生成检查、层级和属性产物；只有 LOD0 非空、索引/面组完整且生成的 GLB 可解析时才发布 `viewerKind:gltf`。不支持或无网格时仍为 `waiting_converter`。X_B 未配置真实 Provider 时仍等待，X_T 受支持子集走 TypeScript 内部转换器。

## 证据等级

| 等级 | 含义 | 当前 JT | 当前 X_T |
| --- | --- | --- | --- |
| L0 声明 | 扩展名/入口存在 | 有 | 有 |
| L1 结构 | 真实样本的头、版本、TOC/schema 可识别 | 有（JT 10.3 TOC、LSG、层级、属性、材质） | 有（SolidWorks PS 24.1 头/schema） |
| L2 几何 | 源文件真实几何可读取并有对照 | 有，但仅限 JT 9.5/10 TriStrip/TopoMesh v1；2 个许可清晰样本 | 有，但仅限 V24.1 单体共轴旋转体子集；1 个 MIT 样本 + 自建回归夹具 |
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
- `@bim-studio/jt-reader` 在固定真实样本上读取 JT 10.3 容器、9 个 Segment、LSG 元素、11 个层级节点、67 个属性原子、材质属性，以及 3 个 LOD 网格；每级为 8 顶点、12 三角面。
- [`jtInspection.ts`](../apps/api/src/jtInspection.ts) 把 reader 结果整理为检查证据、`hierarchy.json` 和 `properties.json`，不把原始顶点数组写入检查 JSON；LOD0 网格 ID 同时进入层级和属性表。
- [`jtGlbConverter.ts`](../apps/api/src/jtGlbConverter.ts) 只选择 LOD0，复用 mesh 定义并按 `meshInstances` 创建节点和列主序 world matrix；`ElementId` 对应唯一实例属性。JT 9.5 部分网格的 group 数按原多边形计，而 indices 已三角化；缺少边界时安全退化为单图元，不猜测面组归属。共享的 [`indexedTriangleMesh.ts`](../apps/api/src/indexedTriangleMesh.ts) 同时服务 X_T 与 JT，避免复制 accessor 构造。
- [`xtStructureProbe.ts`](../apps/api/src/xtStructureProbe.ts) 只读传输头、T/B/PS 标记、modeller/schema identification；不读 B-Rep、NURBS、trim 或 heal。
- [`industrialFormatProbe.ts`](../apps/api/src/industrialFormatProbe.ts) 仅限量读取磁盘样本并调用上述探测器。
- [`xtTextInspection.ts`](../apps/api/src/xtTextInspection.ts) 读取 APPL/FILE/FRU/DATE/GUISE/KEY/SCH 等头部字段并判断是否命中已签署几何子集。未命中时 body、shell、装配、实体名称、颜色和属性绑定都明确标为 `not-decoded`。
- [`xtTextSubsetParser.ts`](../apps/api/src/xtTextSubsetParser.ts) 只接受一个精确 schema 与 10/10/1 圆边/面/圆环面签名，验证共轴、封闭、唯一过渡和资源上限；版本、拓扑或几何签名不符即拒绝。
- [`xtRevolvedMesh.ts`](../apps/api/src/xtRevolvedMesh.ts) 将闭合母线绕 X 轴离散化为 10 个独立可选面；圆环过渡使用解析圆弧采样，其他面保持平面、圆柱或圆锥直母线。
- [`xtTextSubsetConverter.ts`](../apps/api/src/xtTextSubsetConverter.ts) 输出 `geometry.glb`、`hierarchy.json` 与 `properties.json`，不依赖 Rust sidecar、商业 SDK、外部 schema 或候选项目代码。
- [`conversion.ts`](../apps/api/src/conversion.ts) 的 X_T 与 JT 默认接入上述内部子集；JT 仅在 LOD0 非空且 `auditConverterOutput` 成功后发布几何。X_B 仍依赖可选 `INDUSTRIAL_CAD_CONVERTER_COMMAND`。
- [`converterOutputAudit.ts`](../apps/api/src/converterOutputAudit.ts) 验证外部程序产出的 GLB 确有三角网格，并检查 JSON sidecar。它不能证明 GLB 来自源 JT/X_T。
- `jtInspectionAcceptance.test.ts` 使用真实 JT 文件贯通上传、转换、GLB accessor、包围盒、三角数、format-probe、层级、选择 ID 和属性；另通过只改写同一真实文件 TOC 的无 LOD 变体验证 `waiting_converter`。X_B 的 fake converter 只验证管线。

## 真实样本与实测

样本位于 `data/external-assets/format-fixtures/`，源文件、许可和 SHA-256 详见同目录 `manifest.json`。`data/` 当前被 gitignore，因此真实样本未提交到产品代码。

| 样本 | 来源/许可 | 大小 | SHA-256 |
| --- | --- | ---: | --- |
| `voyager-example-block-jt10.3.jt` | [Voyager 固定 commit 样本](https://github.com/TobiasMusin/Voyager/blob/cab6307021b72c5328a66c93cdc8f3bde6b12549/src/main/resources/example_block_jt10.3.jt) / [Apache-2.0](https://github.com/TobiasMusin/Voyager/blob/cab6307021b72c5328a66c93cdc8f3bde6b12549/LICENCE) | 10,330 B | `937a7c41559f9c9cb7f69b3d981b171cbadee417ab1e4f5bcb21b122728403f4` |
| `cadconvert-small.x_t` | [CadConvert 固定 commit 样本](https://github.com/omerbasavul/cadconvert/blob/73b37836a55f905ea0f392cf676dff160c745287/native/crates/cad-convert/tests/samples/small.x_t) / [根目录 MIT](https://github.com/omerbasavul/cadconvert/blob/73b37836a55f905ea0f392cf676dff160c745287/LICENSE) | 6,207 B | `4a6c8c8e5b0a5f2b3674d2f3d15248512bdc19501fe42056374ee4c78b0f387f` |

观测结果：

1. JT 10.3 样本被识别为 little-endian，TOC offset 109、9 entries；完整 LSG 检查得到 11 个节点、1 个根、67 个属性原子和 3 个带材质节点。reader 解出 LOD0/1/2 三份网格；发布只采用 LOD0，得到 1 个 glTF mesh、6 个面组 primitive、8 个源顶点、12 个三角面，包围盒 `[0,0,0]`–`[100,80,60]`。
2. Apache 来源的 JT 9.5 coffee-maker 样本（590,886 bytes，SHA-256 `ea7a1ecbba1c1f04fe11049e8537fca8e9bc0f02af354cd01ea8bb9740c46172`）得到 44 个 LOD0 mesh、64 个遍历实例、23,999 顶点和 47,962 三角面；44 个网格均映射到 shape node。GLB 保持 44 个 mesh 定义，由 64 个 node 复用并应用非恒等 world matrix，几何审计通过。
3. X_T 样本是 SolidWorks 2013 / Parasolid 24.1 文本件。头部可追溯到源文件名、应用、产品版本、日期、guise、key 与声明 schema；结构探测本身仍不读几何，独立几何子集才输出可验证网格。
4. 临时目录中的 CadConvert 仅作差分 oracle，未进入依赖或发布产物。固定参数 `--quality plain --sag 0.05 --angle 8` 得到 1 body、10 faces、1 mesh、2,650 vertices、4,000 triangles，包围盒 `[0,-51.5,-51.5]`–`[63,51.5,51.5]` mm。
5. 自研 TypeScript 子集在同一真实样本上得到 1 body、10 faces、10 selectable meshes、2,795 vertices、4,224 triangles；三角形差异 +5.6%，包围盒逐轴一致。GLB、层级和属性均通过项目审计。
6. 当前仍没有多 CAD 写出端、跨版本装配矩阵、NURBS、损坏语料矩阵，不能提升为 L3 生产兼容。
7. 补充检索发现的其他 X_T 样本分别受 GPL-3.0、无明确许可证或商业 OCCXT 依赖约束；没有找到第二份来源和 MIT/Apache 许可都明确的真实小样本，因此没有把这些文件加入 fixture，也没有用合成文件冒充多 body/多 shell 证据。

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
2. 已实现文件中已三角化的 TriStrip/TopoMesh v1 解码，并通过 late-loaded segment 把网格关联到 LSG shape；输出 LOD0 GLB + `hierarchy.json` + `properties.json` + `inspection.json`。装配实例复用 mesh 并应用累计 world transform，选择属性落在唯一实例 ID 上。
3. 对未支持 codec/element 明确拒绝而不猜测，实施长度、返回引用、压缩比、深度和内存限制。
4. 首版不做精确 XT B-Rep、完整 PMI、shattered/外部分区、JT writer 和 6.x–8.x 全变体。

估算：2 名熟悉二进制格式的工程师，4–8 周完成真实语料上的可视化 V1；达到多厂商/恶意文件生产门禁约 2–4 个月。

### X_T：已交付的窄子集与后续边界

1. 当前直接从受验证的圆边和圆环面解析参数，重建共轴闭合母线；不复制 CadConvert、xt-parser 或 Siemens schema，不携带 `.p2m`/材料资产。
2. 当前明确拒绝其他 schema、非 10 面签名、非共轴/非封闭轮廓、多圆环过渡、重复索引和超限输入；不静默 heal 或猜测自由曲面。
3. 后续若要扩展到通用分析几何，应先补充许可证清晰的多厂商语料，再独立实现 body/shell/face/loop 拓扑；不能从单样本外推。
4. X_B、装配、球面、NURBS/trim、完整 PMI、属性 schema、writer、特征树恢复和“全版本 Parasolid”继续不做。

估算：当前窄子集已完成；扩展到多拓扑分析几何仍需 8–16 周级工作，跨多版本复杂 NURBS/blend 的鲁棒读取是 6–12 个月级风险，不应承诺一次完整复刻 Parasolid。

## 可复现命令

```powershell
# 结构探测回归
pnpm --filter @bim-studio/api exec vitest run src/xtStructureProbe.test.ts src/industrialFormatProbe.test.ts

# X_T 子集解析、真实样本差分与上传主链
pnpm --filter @bim-studio/api exec vitest run src/xtTextSubsetParser.test.ts src/xtTextInspection.test.ts src/xtTextSubsetConverter.test.ts src/modelAssetRoutes.formatProbe.test.ts src/industrialFormatWaitingAcceptance.test.ts

# JT 真实 LOD0、GLB accessor、包围盒、选择与属性链
pnpm --filter @bim-studio/api exec vitest run src/jtInspection.test.ts src/jtInspectionAcceptance.test.ts

# 样本完整性
Get-FileHash -Algorithm SHA256 data/external-assets/format-fixtures/jt/voyager-example-block-jt10.3.jt
Get-FileHash -Algorithm SHA256 data/external-assets/format-fixtures/x_t/cadconvert-small.x_t

# 本地 Three.js loader 清单
Get-ChildItem apps/web/node_modules/three/examples/jsm/loaders -File | Select-Object -ExpandProperty Name
```

本次提交的是 X_T **V24.1 单体共轴旋转体**几何子集，以及 JT **9.5/10 小端 TriStrip/TopoMesh v1 LOD0** 可视子集；两者都不是通用 CAD 内核。JT 的 PMI、纹理、完整源法线和多厂商版本矩阵尚未完成，X_B 未实现；没有引入商业二进制，也没有把任一格式标记为跨版本生产可用。
