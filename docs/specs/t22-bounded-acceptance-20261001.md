# T22 已验证工业格式 profile 有界验收

状态：2026-10-01 root 复跑正式 runtime 消费入口并独立核对34项声明源及3个输入 SHA，通过。按用户“基本通过就验收”的指令，接受下述3个已支持 profile；验证收口，不再扩样本或重复跑同源门。独立收据：ignored `test-output/jc-i-20261001-t22-root-verified.json`。历史 T22 全语义尾项按排除范围保留。

本片按用户2026-10-01“基本通过就验收、不反复扩门”收口现有生产范围：JT 9.5/10.3 LOD0与X_T V24.1单体旋转件。保留JT 8.x结构检查，装配/材质/PMI超出已验证合同的部分明确登记后继。T22原锁定全语义要求与本片有界验收分开记录。

## 现状核查

1. 已搜索packages/jt-reader/src、xt-reader/src、contracts/src与apps/api/src、web/src的JT/X_T、装配、PMI、材质、转换和GLTFLoader调用；核对git status未跟踪源。Reader/转换器/Viewer均已存在，本片不重建。仓内bim-studio/AGENTS.md当前不存在，遵循用户提供的工作区约束。
2. 已读jt-reader/types.ts、xt-reader/entityIndex.ts与index.ts导出合同（此包无types.ts）、contracts/converter.ts、conversionQuality.ts和modelFormatCatalog；现有inspect/preview/visual-complete质量合同、sourceHash/check/loss机制足够。JT PMI只有structureOnly=true；X_T变换已可解析但owner链接未实现。
3. 已查Reader/API package.json；JT固定xz-decompress 0.2.3，X_T无新运行依赖，API已有gltf-transform和内置converter。既有自研TS解析→GLB→Three路径可断网消费，不需商业SDK、schema catalog或CAD软件。未运行Cargo/GPU。
4. 已读conversion.ts三档路由、jtInspection/GlbConverter、xtTextSubsetConverter/GenericConverter和CompatibleGLTFLoader；JT解析层实例/worldTransform与source-path材质真正写出GLB，Web实际loader消费；X_T单体生成body→face层级和默认工业灰，通用档仅PART与独立面几何，transforms只写sidecar并声明not-applied-owner-linkage-unverified。
5. 已查Reader index/xtReader测试、JT GLB/occurrence/inspection/material测试、X_T子集/通用/发布质量测试、T22报告及既有test-output。仓内保留Voyager JT 9.5/10.3 Apache-2.0样本与cadconvert-small.x_t MIT样本；108份X_T历史解析回归不是108份完整几何/装配验收。下一步只运行已有聚焦门并让实际CompatibleGLTFLoader消费代表GLB。
6. 已读唯一工业格式09-16计划、core-plan T22、remaining锁定T22行、T22实施报告、09-27交接、恢复总账、format-support/builtin-profiles与t-audit-batch2。09-28冻结决定仍有效：JT8.x只inspect；不复入删除样本、不追新版本/真实纹理语料、不扩大PMI语义门。

已有（不重建）：JT真实LOD0解码、source-path层级变换/材质、内联纹理子集与结构PMI、X_T单体曲面离散、通用降级几何、现有质量报告/失败拒绝/GLB/sidecar/运行加载链。

真实缺口：X_T source装配owner→transform与name/color链接未实现；现Converter如实报告assembly.instance-linkage与名称/颜色损失，生成默认材质。不能将此默认灰或flattened PART解释成源装配/材质保真。JT PMI dimension/annotation/datum仍无语义消费。当前有界验收将这些列为未支持后继，不为此扩解析器。

## 冻结范围与通过门

| 范围 | 固定输入 | 接受条件 | 排除范围 |
| --- | --- | --- | --- |
| JT 9.5 LOD0 | voyager-coffee-maker-jt9.5.jt，Apache-2.0 | 非空44源mesh/64实例/47962源三角；合法bounds、真实装配路径变换和已有diffuse/opacity材质；API产物与实际Three载入 | 其他9.x编码、精确B-Rep、工程PMI |
| JT 10.3 LOD0 | voyager-example-block-jt10.3.jt，Apache-2.0 | Reader共3级LOD，生产LOD0为1源mesh/1实例/12三角，层级/材质与实际Three载入 | 所有10.x外推、第三方贴图兼容 |
| X_T V24.1 | cadconvert-small.x_t，MIT，SCH_2401231_20000_1300 | 单体10面、4224三角，bounds [0,-51.5,-51.5]→[63,51.5,51.5]；face ID/层级、明确生成材质、实际Three载入 | 多body装配、源颜色/name、非共轴trim/NURBS、工程PMI |
| JT 8.0/8.1 | 不复入删除/本地未授权语料 | 既有结构inspect声明与失败分类继续保留 | 网格ready、PMI、纹理无证据开放 |
| X_T通用档 | 既有合同/测试 | 原支持曲面与显式losses回归不退化 | owner链接/源装配材质不计入完整保真 |

代表输入源hash/离线依赖/消费源hash与新结果写入ignored `test-output/t22-bounded-acceptance-20261001/`。本轮不加压力规模档、不扩大模糊测试或重新下载语料。原三档10万/100万/1000万构件与更广语义均不在此次有界接受范围。

## 验证状态

已有聚焦CPU门：JT Reader 23/23，API七文件32/32，包含真实source→GLB、材质路径、装配实例、截断/非法布局、公开质量合同与发布路径。日志在ignored目录jt-reader.log/api.log。未扩大压力门或下载样本。

薄验证入口runtime-consumer.mts调用正式API转换器、正式CompatibleGLTFLoader.parseAsync与Three BufferGeometry/MeshStandardMaterial，没有替代loader或renderer。三个固定合法输入均实跑通过：

- JT9.5：44源mesh/47962源三角、64实例；真实Three为64mesh occurrence/74166实例展开三角/18材质slot，world bounds与converter精确一致，64个可选ID。区分唯一源几何与实例展开计数。
- JT10.3：生产LOD0的1mesh/12三角，由6个面图元加载为6个Three mesh child，1个可选owner、1材质slot；bounds [0,0,0]→[100,80,60]。PMI保留89个结构实体、8模型视图，structureOnly=true。
- X_T V24.1：10面/4224三角、2795顶点，body→face结构、10可选ID，bounds [0,-51.5,-51.5]→[63,51.5,51.5]、1个生成默认材质slot；sidecar明确generated-labels/not-decoded/header-only/generated-default。

Three实际node.matrixWorld对独立NodeIO读取的GLB世界矩阵最大差0；diffuse/opacity/metalness/roughness对GLB实际材质最大差0，所有position有限、index合法。精确bounds使用Three setFromObject(scene,true)遍历真实顶点；默认保守局部AABB角点变换会扩大旋转件bounds，不将其误判为格式几何缺陷。

所有输入SHA在入口硬校验：JT9.5 `ea7a1ecbba1c1f04fe11049e8537fca8e9bc0f02af354cd01ea8bb9740c46172`；JT10.3 `937a7c41559f9c9cb7f69b3d981b171cbadee417ab1e4f5bcb21b122728403f4`；X_T `4a6c8c8e5b0a5f2b3674d2f3d15248512bdc19501fe42056374ee4c78b0f387f`。runtime-receipt.json记录source-before/after守卫、派生GLB SHA与真实消费结果，sourceFresh=true。

复跑入口：`node --conditions=development --import ./apps/api/node_modules/tsx/dist/loader.mjs test-output/t22-bounded-acceptance-20261001/runtime-consumer.mts`。只生成ignored产物，不修改正式源。

结论：当前JT9.5/10.3 LOD0与X_T24.1单体profile达到本轮“基本通过”的CPU/真实runtime接受门，可以接受此有界范围。X_T通用降级语义不提升为完整装配/材质保真；JT8.x/高阶PMI/更广格式与三档规模作为排除后继，原T22全语义锁定行不偷换为整项完成。GPU/浏览器由根路串行负责；本片未运行浏览器视觉，不报视觉评分。
