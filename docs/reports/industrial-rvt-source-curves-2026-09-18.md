# RVT 2024 持久曲线与闭合线轮廓

从 Core Interior 原始曲线载荷恢复了 2,483 条直线；其中 101 个完整 owner 组形成闭合线轮廓，1,781 条源线导出为 `LINES` GLB。当前是源曲线 preview，未生成楼板/墙体实体，也未接产品 Worker。

## 新证据

不是从草图索引 bbox 恢复坐标。实际曲线存在于另一段持久记录中：

```text
ElementId:u64 | hash-like:u32 | bodyLength:u32 | body | bodyLength:u32
body 起始标记：0x0392
body 最后 68 bytes：04 00 08 01 | range:f64[2] | origin:f64[3] | direction:f64[3]
```

解码要求长度首尾一致、已声明草图 ID、有限参数、递增参数域、单位方向向量。曲线前的原始引用还须存在于同 ID 草图元数据的 reference list；该引用未命名为 container/type 等未证明语义。坐标直接由 `origin + t * direction` 求得。

- Element20954：`Partitions/46:5758871`，记录 671 bytes；源域 0..8 ft，origin=(136.5,115,91)，direction=(0,1,0)。重复分区 `/51:360604` 完全相同。
- Element20955：`Partitions/46:5759542`，记录 671 bytes；源方向约 (0.9524241472,-0.3047757271,0)，实际端点 (136.5,123,91)→(161.5,115,91)。这是 bbox 两条可能对角线中的一条，由源方向明确决定。
- 51 条线与索引 bbox 不完全一致，最大差 1 ft；例如 Element16318 的真实线是 (20,114,76)→(167,114,76)，其元数据范围有额外 1 ft。bbox 仅作诊断，不参与重建或强行吸附。这也说明上一版 bbox 路线不能替代实际载荷。

同 ID 多分区记录只有 owner、原始引用、参数域、origin、direction 全部相同时才合并，保留每个原始 offset/记录 SHA。不同几何不采用 first/last 胜出。

## 闭合检查与结果

按源 owner 关联直线，只接受该组所有已声明草图线均已成功解码的完整组；缺少任何边就拒绝该组。端点连接误差为 1e-7 ft（0.00003048 mm），检查度数 2、每条边恰消费一次、水平平面、非零面积和环内自交。

| 项目 | 实测 |
|---|---:|
| 已声明草图线身份 | 3,064 |
| 持久直线载荷 | 2,483 |
| 缺失或其它曲线类型 | 581 |
| owner 组 | 126 |
| 完整闭合线轮廓组 | 101 |
| 缺边 / 开口或分支 | 21 / 4 |
| GLB 原始线段 | 1,781 |
| 最大 Float32 误差 | 0.001049805 mm |

例如 owner16317 为 4 条源线组成的 147×89 ft 闭环，面积 13,083 ft²。owner16283 有 27 边外轮廓及 4 边内环；本阶段保留各环，不凭面积顺序认定孔洞，不拉伸实体。孔的包含关系、实际楼板/墙体关联、源上下界及活动记录语义属于下一片。

## 实现与验证

- `scripts/fixtures/rvt-sketch-line.rs`：窄版本持久 line 解码。
- `scripts/fixtures/rvt-sketch-line-audit.rs`：元数据身份关联、重复记录比较、源字节证明。
- `scripts/lib/rvtSourceProfiles.mjs`：闭合线轮廓检查。
- `scripts/audit-rvt-source-profiles.mjs`：源线 GLB（mode=LINES），按 owner 保留身份和米制坐标，量化误差须低于 0.01 mm。
- `scripts/audit-rvt-sketch-lines.ps1`：复用固定 Reader 离线编译缓存，编译工具、双跑、源哈希不变、执行 2 项 Rust + 4 项 JS 测试并记录源码/依赖/产物哈希。测试包含错误身份/长度/标记/引用、截断、NaN、缺边、自交、非平面、真实斜线方向及逐条 GLB 反解对照。
- 两个 `rvt-*-probe.rs` 是只读原始字段研究工具，不作为几何验收器。

权威产物目录：`test-output/rvt-source-curves-20260918-v2/`。双跑 source-lines JSON 完全一致；源码未修改上游 Reader。

| 文件 | SHA-256 |
|---|---|
| source-lines.json | `aab6154d7369e48a166224b3807849ee2d94beee3b72302ca38550e4584834c7` |
| profiles.json | `4af950336543a51b1cc940a5b95f7a56f321dccaa743403bfc8840fbb7f910f3` |
| source-wires.glb | `18270af8b39fbcaeb575ecc2866bf534287f628a13ac24c0b89f5fc246502ba2` |
| evidence.json | `3ea8aebcd2302768f767a029e5174a5b3c8a9b181524840dcc6630ea22d24be6` |

源文件 SHA-256 仍为 `c805df445d613b408e37337765572021265e3f5dfdc7d1fa53b22ba1600b8014`，来源及授权沿用 2026-09-17 源身份报告。仅一个 2024 样本证明的窄 profile；无实体、曲面或产品完成声明。

复跑：

```powershell
./scripts/audit-rvt-sketch-lines.ps1 -SourceFile data/external-assets/industrial-format-plan/samples/rvt/2024_Core_Interior.rvt -DependencyDirectory test-output/rvt-source-identity-20260917-final/build/ci/deps -OutputDirectory test-output/rvt-source-curves-repeat
```

2023 Einhoven 分支没有拿到已证明的 WallType 厚度：所谓 type8570 的原始记录邻接 `Family1`、compound 载荷，不能仅凭上游命名赋予 WallType/中心线语义。因此本片转向具备显式方向及参数域的 2024 源线，不输出默认墙厚模型。
