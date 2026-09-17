# 工业格式 PLAN-01/02 第一批语料与依赖锁定报告

日期：2026-09-16。状态：**第一批证据已锁定；部分 OSS 已完成 Windows 试编译，尚未完成依赖集成或格式生产支持**。

本报告收口 `industrial-3d-format-work-plan-2026-09-16.md` 的 PLAN-01/02 第一批工作。权威机器可读清单位于本地忽略目录 `data/external-assets/industrial-format-plan/corpus-manifest.json`；该目录保存下载工件、解包核验副本和逐文件哈希，不进入 Git。仓库只提交本报告中的结论与边界。

## 1. 结论

- 已固定 8 个第三方源码工件、1 个 PDAL 官方校验文件、2 个真实 RVT、E57/点云/3D Tiles/3DM 等公开或上游测试集，以及仓内 JT/X_T 既有语料索引。
- 8 个已下载依赖工件和 6 个单独下载样本的 SHA-256 均与 manifest 一致；7 份解包样本校验表共 463 个文件，逐文件复算全部一致。
- 本地证据树共 8,486 个文件（依赖 7,715、样本 763、根清单/校验表 8），约 561.7 MB；其中下载工件合计 208,690,811 字节，其余主要为解包核验副本。
- 候选库没有写入产品依赖；后续已完成 `parasolid-kit`、X_T Rust 研究解析器和部分其他 OSS 的 Windows 试编译。试编译与语料解析结果只证明技术路线可执行，不证明格式已经可转换或可发布。
- 七方向的真实生产语料仍不完整。2026-09-17 已补 109 份制造商公开下载的真实 X_T，原“只有一个”结论失效；这些样本来自同一发布方，只用于本地评估且不进入仓库。SolidWorks 仍没有真实 SLDPRT/SLDASM，RVT 学科覆盖不足，3D Tiles 样本许可未声明。

## 2. 依赖锁定

| 工作包 | 依赖 | 锁定版本 | 许可结论 | 工件状态 | 构建状态 |
| --- | --- | --- | --- | --- | --- |
| WP-JT | 仓内 `@bim-studio/jt-reader` | 0.1.0 | 第一方 DMCSL-1.0 | 仓内组件 | 既有实现，本批不重建 |
| WP-X_T | `parasolid-kit` | v0.2.0 | MIT + Apache-2.0 | 已下载并校验 | `cargo build --release -p parasolid-core --locked` 成功；159 项测试通过 |
| WP-RVT | `rvt-rs` | v0.1.2 | Apache-2.0 | 已下载并校验；main 快照只作语料 | 未试编译 |
| WP-PC | `libE57Format` | v3.4.0 | BSL-1.0 | 已下载并校验 | 未试编译 |
| WP-PC | `laz-perf` | 3.4.0 | Apache-2.0 | 已下载并校验 | 未试编译 |
| WP-PC | `PDAL` | 2.10.2 | BSD 类，逐组件仍需复核 | 101,975,261 字节源码包未下载；官方 sha256sum 已保存 | 未构建 |
| WP-TILE | `3d-tiles-renderer` | v0.5.2 | Apache-2.0 | 已下载并校验；仓内尚未安装 | 未集成 |
| WP-3DM | `openNURBS` | v8.35.26251.13001 | 自定义许可，当前 NOASSERTION | 已下载并校验 | 未试编译，分发前法务复核 |
| WP-3DM | `rhino3dm` | v8.32.0 | MIT；内嵌 openNURBS 另审 | 已下载并校验 | 未试编译 |
| WP-SW | `cadmpeg` | v0.6.0 | 代码 Apache-2.0，文档 CC-BY-4.0 | 已下载并校验 | 未试编译 |

PDAL 源码包超过本批单文件 100 MB 下载上限，因此当前不是完整依赖锁。后续若进入 WP-PC 实现，必须下载完整工件、复核官方哈希、依赖树与测试数据逐文件许可，再冻结可复现构建。

## 3. 样本证据与适用边界

| 工作包 | 当前证据 | 可证明 | 不能证明 |
| --- | --- | --- | --- |
| WP-JT | 仓内 JT 9.5 与 10.3 两个真实样本 | 既有小端 TriStrip/TopoMesh 子集回归 | LOD、B-Rep、PMI、多文件引用和版本矩阵 |
| WP-X_T | MIT 小样本 1 份；Asmith 制造商公开下载真实 X_T 109 份；另有 1 份来源边界未清的本地工程样本；`parasolid-kit` 合成 corpus | 109 份制造商样本全部由产品 `xtStructureProbe` 识别，可建立 V9/V21/V30 多 schema 保留集 | 独立生产方覆盖、真实 X_B、完整曲面/拓扑解析和通用兼容 |
| WP-RVT | 两个 MIT 授权真实 RVT；`rvt-rs` 三组合成 CFB fixture | 两个真实文件的容器输入与 reader 回归素材 | 建筑/结构/机电/链接齐全的多版本矩阵 |
| WP-PC | E57 21 文件；LAS/LAZ/COPC 10 个单独样本；laz-perf 23 文件 | 正反例、颜色/CRS/扩展属性、压缩对照 | 大规模、多站、大坐标、完整配准和驻留预算 |
| WP-TILE | 官方示例仓库 222 文件、9 个 tileset | implicit tiling、多内容、元数据等内部评估 | 可再分发许可与完整传统 b3dm/i3dm/pnts 覆盖 |
| WP-3DM | rhino3dm 13 个测试模型；openNURBS V1-V8 共 153 个样例 | 版本读取、块/网格/SubD/用户字符串等回归素材 | 大型真实工程、深层块、完整材质贴图与无缓存曲面离散 |
| WP-SW | cadmpeg 21 个小型合成 SLDPRT fixture | L1 容器/golden 回归 | 真实零件、SLDASM、配置、装配 occurrence 和几何完整性 |

3D Tiles 示例仓库没有 LICENSE 文件，当前只能内部评估，不进入产品安装包、公开下载或第三方通知。openNURBS 许可文本需要法务复核；PDAL 测试数据需按上游“unless otherwise indicated”逐文件确认来源。

### 3.1 2026-09-17 X_T 语料扩充实测

- 来源：Asmith Manufacturing Company 的公开 [3D 下载页](https://www.asmith.com.tw/en/downloads/3D)，页面明确提供 Parasolid `.x_t`；铰链分类由其公开 Google Drive 链接分发。
- 工件：外层实际为 RAR 容器，22,182,888 字节，SHA-256 `cdf54f79edf0ad19c91213c2ca5fd1d51f8acd582d3fd0f024201b3a477cde90`；含 39 个子压缩包。
- 安全解包：先拒绝绝对路径和 `..` 路径，再逐层解包到 gitignored 语料区；得到 109 份 X_T，共 33,986,456 字节，109 个内容哈希均唯一。
- 产品探测：109/109 `header-recognized`，0 invalid；schema 分布为 `SCH_901000_9008` 31、`SCH_2100263_20000_1300` 70、`SCH_2100275_20000_1300` 1、`SCH_3001278_30100_1300` 7。
- 使用边界：发布方提供下载，但页面未给出明确再分发授权；原始 CAD 仅保留在 `data/` 本地评估，不提交、不随产品分发。机器可读来源与逐文件结果为 `samples/downloaded/x_t/asmith-hinges-source.json` 和 `asmith-hinges-inventory.json`。
- 下载恢复：Mastervolt 与 Emerson 两个公开样本端点被 Cloudflare 拒绝后，没有将其报作阻塞，转用 Asmith 官方公开分发源完成本批。

### 3.2 X_T 纯 Rust 解析路线实测

- `parasolid-kit` 对四类代表样本均按设计拒绝，精确原因是 `schema.missing_base_schema`；这不是商业 SDK 或许可证阻塞，而是当前开源 profile 未携带这些历史 schema。
- 随后复用本地 Apache-2.0 Rust 研究解析器 `data/external-assets/format-research/xt-parser`。修复旧 CAD 元数据的单字节编码读取，并把“解析中断后返回部分几何”改成 fail-closed，防止半截拓扑被误报为成功。
- 对 109 份真实样本全量复测：完整解析 49，拒绝 60。成功项中 `SCH_2100263_20000` 为 44/70，`SCH_3001278_30100` 为 5/7；失败项为 `SCH_1901254_19008` 31/31、`SCH_2100263_20000` 26/70、`SCH_2100275_20000` 1/1、`SCH_3001278_30100` 2/7。
- 49 个成功文件产出 140 body、50 shell、2,900 face、3,245 loop、15,588 fin、2,364 surface、7,237 curve、7,794 edge 和 4,966 vertex/point。该统计用于冻结实验 profile，不代表其余 60 个文件可降级为部分几何。
- 下一实现顺序：先将这 49 个已完整解析样本接入版本化原生 Worker/质量报告；再按收益补 V21 差异流，之后处理 V9 基础模式。整个路径保持本地离线，不引入商业 SDK、商业转换器或许可证服务。

## 4. 完整性复核

本批执行的本地复核结果：

- manifest 中 8 个已下载依赖 tarball：文件存在，SHA-256 全部匹配。
- manifest 中 6 个带单工件哈希的下载样本：文件存在，SHA-256 全部匹配。
- `3dm-opennurbs` 153、`3dm-rhino3dm` 13、`3dtiles-samples` 222、`e57-test-data` 21、`laz-lazperf` 23、`sldprt-cadmpeg` 21、`xt-parasolidkit-corpus` 10：共 463 个解包文件，路径与 SHA-256 全部匹配。
- 两个 RVT 文件的下载哈希与上游 Git LFS 指针 oid 一致。
- 本地证据目录由仓库 `.gitignore` 的 `data/` 规则覆盖，不会把约 561.7 MB 原始工件误提交。

## 5. 停止条件与下一步

第一批 PLAN-01/02 到此仅完成“证据锁定”。以下条件未满足前，不得把候选标记为产品支持：

1. 候选依赖在固定 Windows 工具链上离线构建成功，并记录二进制 hash、安装体量、冷启动、峰值 RSS 与临时磁盘。
2. 许可未决项关闭：3D Tiles 样本换成明确授权语料或取得授权；openNURBS 完成法务结论；PDAL 测试数据完成逐文件复核。
3. 每个开放 profile 有独立来源正例、损坏反例、保留集、确定性输出、source map 与错误报告；合成 fixture 不能替代真实语料。
4. PLAN-03 合同接入真实 Worker 和质量审计后，才能进入 PLAN-04/06 的任务统一与原子发布。

下一片建议先补 PLAN-02 的 Windows 离线试构建矩阵；样本扩充优先级为真实 SLDPRT/SLDASM、独立来源 X_T 与真实 X_B、多学科 RVT、许可明确的 3D Tiles 和多站大坐标点云。
