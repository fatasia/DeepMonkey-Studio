# 内置 profile 登记表

> 本文登记随包内置、本地离线可用的格式 profile 及其验收状态。
> 总表见 [format-support.md](./format-support.md)；运行链与验收记录见
> [converter-plugin-and-format-support.md](./converter-plugin-and-format-support.md)。
> 纪律:profile 状态只能随真实样本/固定参考证据升级;合成样本只验证解码边界,
> 不升级真实样本声明;依赖部署方自备文件或源软件的路径不登记为内置 profile。

## 1. JT

### JT 8.0/8.1 — **仅结构检查，不进入 LOD0 几何 ready profile**

本机真实样本验证了容器、场景层级、实例和材质数值读取，但样本没有受支持的网格段；8.x 网格、PMI 与纹理图像绑定未验证。结构检查成功不等于几何可浏览，来源不具备再分发依据的样本仅用于本地验证。详细边界见 [format-support.md](./format-support.md#jtpackagesjt-reader)。

### `builtin-jt-lod0-visual-complete` — **内置,合规生产（限已验证 LOD0 样本 profile）**

| 项 | 内容 |
| --- | --- |
| 覆盖版本 | JT 9.5 与 10.3（小端、真实样本已验证的 LOD0 视觉档；不据此外推所有 10.x 或 9.x 编码） |
| 质量档 | `visual-complete`(LOD0 视觉完整,非 engineering-verified) |
| 实现 | `packages/jt-reader`(TypeScript,内置,零运行时外部依赖除 xz-decompress) |
| 注册依据 | `packages/contracts/src/modelFormatCatalog.ts`(`builtin-jt-lod0-visual-complete`) |
| 真实样本 | Voyager coffee maker(JT 9.5,SHA-256 `EA7A1ECB…740C46172`)、Voyager example block(JT 10.3,SHA-256 `937A7C41…122728403F4`),Apache-2.0,清单见 `data/external-assets/format-fixtures/jt/` |
| 已验证 | 容器/TOC/LSG、Deflate/XZ、CDP/CDP2、TopoMesh 拓扑与量化/无损属性、装配实例/变换、材质路径、多纹理集 UV 源编号保真、PMI 结构清单 |
| 已知限制 | B-Rep/精确曲面不解析、PMI 语义未解析、HSV 颜色与附属字段拒绝、材质图像→纹理集映射无样本证据 |
| 机读契约 | 错误码与损失码词表见 [format-support.md](./format-support.md#jt-packages-jt-reader) |

## 2. Parasolid X_T

### `builtin-x-t-revolved-subset` — **内置,合规生产(限子集)**

| 项 | 内容 |
| --- | --- |
| 覆盖 | V24.1 单体共轴旋转件(`SCH_2401231_20000_1300`;plane/cylinder/cone/torus),文本格式 `.x_t` |
| 质量档 | `visual-complete`(命中子集时);未命中转通用档或 inspection |
| 真实样本 | 单份 MIT 样本 L2 通过 |

### 通用降级档(xt-reader)— **内置,合规生产(限已验证曲面族)**

平面/圆柱/圆锥/球面族按证据发布 `visual-complete`;trim/名称/颜色/装配/legacy-baseline
编码如实进 losses;108 份真实样本解析回归(`test-output/xt-generic-parser-regression-20260925.json`)。

### 第三档 schema-aware — **不登记为内置 profile**

依赖部署方自备 Parasolid 官方 schema catalog(`PARASOLID_SCHEMA_CATALOG`)。
**不满足内置离线硬门槛,不计入合规生产能力**;仅部署方自担增强路径与本地研发验证。

### parasolid-kit v0.2.0 五个内置 key profile — **本地研发验证,未计入内置验收**

vendored `parasolid-core`(MIT/Apache-2.0)内置五个精确 key 的 `verified_subset` profile
(零 user fields,profile 哈希锚定已审计定义)。**本机真实语料(AS-2059 的
`SCH_2100263_20000_13006`、A-2621 的 `SCH_901000_9008`)均不在五 key 之内,也未取得
与五 key 相符的可再分发真实样本**,故五档仅保留本地研发验证,
`--builtin-profile --brep` 对上述真实语料明确报"无内置 profile 覆盖";
在取得匹配真样本并完成 raw→B-Rep→三角化→audit→GLB 端到端验收前,
**不升级为内置生产能力**。

| 精确 key | profile / 修订 | 状态 |
| --- | --- | --- |
| `SCH_3000000_30000` | `onshape-sch30000-r3` / 3 | 本地研发验证;无匹配真实样本,未计入内置验收 |
| `SCH_1300000_13006` | `onshape-sch13006-r6` / 6 | 本地研发验证;无匹配真实样本,未计入内置验收 |
| `SCH_3000310_30000_13006` | `icad-sch30000-13006-r5` / 5 | 本地研发验证;无匹配真实样本,未计入内置验收 |
| `SCH_3701212_37102_13006` | `onshape-sch37102-13006-r3` / 3 | 本地研发验证;无匹配真实样本,未计入内置验收 |
| `SCH_3701229_37102_13006` | `solidworks-sch37102-13006-r1` / 1 | 本地研发验证;无匹配真实样本,未计入内置验收 |

来源:`data/external-assets/industrial-format-plan/dependencies/extracted/parasolid-kit-v0.2.0`
(fixed v0.2.0,逐文件审计与可复现构建要求见权威计划;kit 不入 Git)。

## 3. RVT

**现有产品转换链可用，但不属于“随包内置、无需源软件”的 Reader profile。** 在配置了 Windows Revit Worker、安装并授权兼容版本 Revit 的部署条件下，RVT 可走上传→原生 GLB 或 IFC 转换→资产发布→Web 查看链；本机历史真实样本已有 GLB、层级和属性产物。这与“无需 Revit 的内置离线解析尚未验收”是两种不同口径，不能互相否定。本轮未重跑两种模式的完整浏览器端到端测试。

本表的 **builtin-only 口径仍无 RVT 内置 Reader profile**。Revit Worker 不计入该口径；RVT 内置 Reader 的容器/Schema 解码依权威计划属 `bim-rvt-pack` 后续工作。

## 4. 点云 / 3D Tiles / 3DM / SolidWorks

依权威计划分属 `pointcloud-pack`、`3dtiles-builtin`、`3dm-builtin`、`solidworks-pack`,
当前切片未触及,不在此登记;立项时按同一登记格式补充。
