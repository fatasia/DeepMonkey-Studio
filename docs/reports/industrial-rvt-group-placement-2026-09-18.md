# RVT：源模型组引用与 11 个成员实例

本片为 RVT 离线研究桥补齐模型组几何引用。11 个成员已从实际组实例的原始引用矩阵生成 GLB，保持独立预览；未并入默认整楼场景。

## 根因与证据

先前把带 `containerRaw` 的元素统一拒绝，避免将定义坐标误当世界坐标。这不是“26 个已解析实体都缺 placement”：26 个容器成员中，14 个有已支持简单 BRep，12 个为复杂载荷；先前 52 条简单 BRep 记录包含重复分区记录。

本片发现容器类别原始值为 `-2000095`，对应模型组类别；该枚举可由 [Autodesk 官方示例](https://images.autodesk.com/emea_apac_main/files/lesson_5.pdf) 核对。源文件中实际读取 10 个定义、11 个实例元数据，以及 9 个实例几何引用载荷。定义采用 `98050000`，逻辑实例载荷采用 `8d050000`，几何引用载荷采用 `3f08ffffffffffffffff`。

**几何引用矩阵与逻辑实例 placement 必须分开。** 例如实例 27419 的逻辑记录包含非零平移，但其持久化几何引用对成员 26913 明确存储单位矩阵。成员 BRep 已含自身实际高度，再叠逻辑平移会移动两次。导出只消费几何引用图；bbox 只用于导出后的包含性校验。

源版本仍为 2024 Core Interior，SHA `c805df445d613b408e37337765572021265e3f5dfdc7d1fa53b22ba1600b8014`。上游版本和离线依赖不变。

## 实现的窄载荷合同

`scripts/lib/rvtGroupGeometry.mjs` 校验源身份、首尾长度、载荷标记、索引序列和尾部列表标记。引用数取记录 `+38` 的 u32，尾部每条引用严格 112 字节：12 个 f64、成员 u64、两个固定标志。每条保存原始矩阵、源字节偏移、引用序号和组实例 ID。

成员必须同时满足：实际组实例类别/placement 标志正确，成员 owner 与组 owner 一致，组几何明确引用该源成员，BRep 本身通过原有六平面/双侧 UV 检查，独立四曲线轮廓复核通过。不同组或重复引用以完整路径保存，不按成员 ID 合并。

实际保留集只证明单位矩阵引用，运行导出遇到非单位矩阵仍拒绝。反射、平移和绕序修正目前只有合成数学回归，不能当真实 RVT 非单位矩阵支持。

## 实测结果

| 结果 | 唯一成员数 |
|---|---:|
| 真实组引用 + BRep + 草图复核通过 | 11 |
| BRep 可解，但草图复核不足 | 2 |
| BRep 可解，但缺少组几何引用 | 1 |
| 复杂载荷 / 未满足唯一简单记录 | 12 |

通过的实例/成员：19276/{16317,16918}、22380/{21993,22026}、24537/{23164,23239}、27419/{26913,26988}、54182/{33774,33849}、21943/21934。27422、27497 未放宽草图复核；87625 未补造组引用。

11 件共 132 个三角形，逐个通过闭合边、正体积、量化无塌缩检查。实际 GLB 最大三维坐标误差 **0.0013782735647025544 mm**，小于 **0.01 mm**。源组合范围为 X [20,167]、Y [25,114]、Z [-43,91] ft；每个实例都落在对应源组的诊断范围内。计算坐标时不读取诊断范围。

**11 个成员均与之前独立导出的某个源实体几何重合。** 这是组实例与定义/独立身份关系的进展，不代表新增长楼层或可见面积。机器证据 `overlaps` 逐项列出重合身份；仍缺活动组/设计选项选择语义，不将两批 GLB 自动混合，避免重叠面。

## 验证与复现

- 3 个新增测试覆盖 9 份真实组图、身份/长度/索引/矩阵损坏、重复实例路径、反射绕序、错误 owner、真实 11 份 GLB 坐标和闭合拓扑；均通过。连同原平面实体测试共 **8/8**。
- `pnpm gate:repository` 通过。
- 复用已有诊断页做三份实际 GLB × 两轮不同尺寸/视角，共六张截图，已逐张检查，无裁切或浏览器错误。验收范围仍为几何诊断；沿用上一片的视觉自评和局限，不宣称产品完整视觉验收。

源提取器：`scripts/fixtures/rvt-container-source.rs`。结果 `test-output/rvt-container-source-20260918-v2.json`，SHA `ecea4c100d39c58bbded625d6a0d9645969dd9c585f4aa9638ada7bb68a0248d`。

最终结果：`test-output/rvt-group-solids-20260918-v3/evidence.json`，SHA `3f3b732c68610a806578cece80d784aba83713d7d5a6c655218b36c057d58885`。单件 GLB 位于同目录各 `element-*` 子目录。视觉证据在上一轮 `test-output/rvt-group-solids-20260918-v2/visual/`；两轮单件 GLB 哈希保持相同。

```powershell
node scripts/audit-rvt-group-solids.mjs test-output/rvt-container-source-20260918-v2.json test-output/rvt-planar-family-source-20260918-r2.json test-output/rvt-source-curves-20260918-v2/profiles.json test-output/rvt-source-curves-20260918-v2/source-lines.json <new-output-directory> test-output/rvt-planar-family-20260918-v2
```

测试需设置 `RVT_GROUP_SOURCE`、`RVT_GROUP_OUTPUT`、`RVT_FAMILY_SOURCE`，执行 `node --test scripts/rvt-group-geometry.test.mjs`。下一片应优先解活动组/设计选项及实际非单位几何引用，而不是将所有定义无条件加入场景。
