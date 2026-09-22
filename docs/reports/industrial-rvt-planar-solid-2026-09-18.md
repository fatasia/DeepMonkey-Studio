# RVT 2024 首件真实闭合平面实体

Core Interior 的 Element21975（源分类 Site Pad）已从持久 BRep 解码为闭合实体：8 顶点、12 条共边、6 面、12 三角形。上下界来自源平面，未使用 bbox 高度或默认厚度。

## 源证据

源 SHA-256：`c805df445d613b408e37337765572021265e3f5dfdc7d1fa53b22ba1600b8014`。来源/授权沿用工业源身份报告。

- 元数据：`Partitions/46:3026263`，Element21975，分类 -2001263，standalone placed instance。
- 实际几何：`Partitions/46:51286107`，ElementId 三处一致，bodyLength=3684，首尾长度一致，总记录 3704 bytes，geometry carrier `3f 08 d5 01`。
- 记录声明 6 面 / 12 边。末尾有 6 个平面 frame，每个含 origin、两条正交单位基向量；中段每条边同时记录相邻两面 ID 及两侧 UV 端点。
- 两侧 UV 经各自平面 frame 计算后，全部共边端点一致；最大残差 7.11e-15 ft。直线和平面均为线性，本片不依靠离散最近点吸附。
- 6 个面各形成单一凸四边形；8 个顶点各关联 3 边；12 条三角形网格边（另有面内对角线）按无向边检查均有两条反向邻接。源面 ID 4..9 保留到 GLB primitive。

## 实测几何

| 项目 | 值 |
|---|---:|
| 源下界 | -43 ft |
| 源上界 | -41.5 ft |
| 源平面间距 | 1.5 ft / 457.2 mm |
| 平面面积 | 13,083 ft² |
| 正向体积 | 19,624.5 ft³ |
| GLB 最大 Float32 误差 | 0.000827027 mm |

同 owner 的真实草图线 21976/21979/21978/21977 与棱柱盖面的 XY 边界逐边一致，单环、无孔。草图 Z=0，而实体平面位于 -43/-41.5 ft；本片没有把草图 Z 当世界放置，也未猜偏移字段。实体顶点全部从 BRep 平面与共边获得，草图只作为独立 XY 边界对照。

## 实现与检查

- `scripts/fixtures/rvt-planar-solid-source.rs`：固定 Reader 离线缓存，抽取长度框定几何记录并关联源分类/身份。
- `scripts/lib/rvtPlanarPrism.mjs`：六平面/十二双侧共边窄 profile；拒绝其它结构，不含 Element21975 特判。
- `scripts/audit-rvt-planar-prism.mjs`：源曲线对照、实体 GLB、量化预算、SHA 绑定。
- `scripts/rvt-planar-prism.test.mjs`：3 项测试通过，含真实闭合实体、错误 ID/长度/拓扑/UV/有限域/NaN/截断、GLB 世界坐标与流形邻接。把原记录 bbox 字节 48..143 清零后，解码顶点完全相同。
- 源记录双跑 SHA 相同，GLB 双跑 SHA 相同；没有丢面、删退化三角或包围盒回退。

首件证据：`test-output/rvt-pad-source-20260918.json` 和 `test-output/rvt-pad-solid-20260918/{source-solid.glb,evidence.json}`。

| 产物 | SHA-256 |
|---|---|
| 原始记录检查 JSON | `245d4f1a8a9ffe19977fb9ab45a42032f8c789845dcf4ed679a3c9680735aab3` |
| source-solid.glb | `7890869f49c1f1a22c3fc3eddd2f8d30e4586e15039d80c93f13d783c7783f72` |

这是单一真实构件的 `source-planar-solid-preview`，不是整栋建筑、任意 BRep、完整 RVT 或产品 Worker 完成。后续按同一严格解析器扩大同族，保留其它结构拒绝统计；孔洞和多环不套用本棱柱 profile。
