# F5 方向修复拍板级设计：96B reserved 启用 vs 方向 atlas（2026-10-03，主线程，零生产修改）

> 目的：把「方向修复（96B 扩展或方向 atlas）留用户拍板」的前置设计做完整，拍板后零延迟开工。
> 本文档零生产代码改动；约束原文（f5-radiance-irradiance-consumption）："不得偷偷占 reserved 作为公共 SH；先精确报告预算/生命周期/公共记录影响，确认后动手。"

## 1. 现状精确布局（pack 源码实证）

`IrradianceProbeRecord` = 96B = 24 f32 words（`DEEP_GI_PROBE_RECORD_BYTES=96`，probeClipmapPlan.ts:84；pack 实现 probeClipmapSampling.ts `packIrradianceProbeRecord`）：

| words | 字段 | 现状 |
|---|---|---|
| 0..2 | irradiance RGB | 在用 |
| 3 | validity | 在用 |
| 4/5/6 | meanDistance / distanceVariance / occlusionFloor | 在用 |
| **7** | 空（显式写 0） | **空闲 1 word** |
| 8..10 | positionOffset | 在用 |
| **11** | 空（显式写 0） | **空闲 1 word** |
| **12..23** | reserved（native 合同要求全零，pack 注释在案） | **空闲 12 words = 48B** |

镜面 IBL 现状：方向可见度语义裁定（f5-variant-semantics）为「有效域内 clamp(L(probe)/L(env),0,1)，Rec.709 标量；域外/近黑恒 1」——**全域标量**，intFloorBack 漏光（地板背面）正是标量语义无法表达的方向差。

## 2. 方案 A：reserved 启用 RGB L1 SH 方向可见度（推荐）

- **数据**：可见度标量场的 L1 球谐（4 系数/通道 × RGB = 12 floats），恰好填满 words[12..23]。零记录加长、零 stride 变更。
- **捕获**：探针捕获链已有 32 方向射线（frameBudget=8×32=256，在案）——按既有方向权重做 L1 投影（复用 probeRadianceKernel 的方向集与权重；无新预算）。
- **生命周期**：随 record 打包/更新同周期，零新增资源、零新增绑定槽（仍在 binding 11 storage 流内）。
- **消费**：镜面路径已有 `probeSpecularEnvironmentVisibility`（f5-variant-semantics 交付的标量门）；切换为 L1 重建的方向可见度 `clamp(shL1(dir)/L(env),0,1)`——数学复用既有 SH 求值（Frame deepDiffuse 64B 的 L0/L1 同族）。
- **双端契约**：native reserved 合同从「words[12..23] 全零」升级为「words[12..23]=RGB L1 SH 可见度（f32 小端，系数序 l0,m0,l1m-1,l1m0,l1m1）」——`renderer_capability_manifest` + native 同形声明 + 金样 JSON 三方对拍同步（既有四方对拍机制直接覆盖）。
- **对拍**：白炉负控（均匀可见度=1 时 L1 全零、输出与现版本逐位同）；intFloorBack 场景门（1.843→≤1.1 目标，同 32 方向 CPU 参考对拍）；Chebyshev 通道方向性验证（f5-l4 遗留清单项）。
- **风险**：L1 方向锐度有限（大尺度方向差足够，镜面级锐阴影不足）——若未来需要镜面级锐度，方案 B 叠加不冲突（A 先行不堵 B）。

## 3. 方案 B：方向 atlas（独立可选通道纹理）

- **数据**：每探针 32 方向标量可见度 → R16F 纹理阵列（宽 32 × 高 probeCount），mip 由采样侧插值。
- **生命周期**：独立资源随 clipmap 重建/重定位管理——新增创建/更新/释放路径与驻留预算（streaming 域交接）。
- **消费**：新绑定槽 + 采样代码（web WGSL + native 双端）。
- **收益**：32 方向锐度高于 L1；**成本**：资源生命周期/绑定槽/双端采样/预算管理全套新增——约为方案 A 3–4 倍工作量。
- **适用**：方案 A 落地后仍不满足镜面锐度时的叠加项。

## 4. 对比与推荐

| 维度 | A：reserved 启用 L1 | B：方向 atlas |
|---|---|---|
| 记录布局变更 | 无（96B 不变） | 无（独立纹理） |
| 新增资源/绑定 | 无 | 纹理+绑定槽+生命周期 |
| 双端契约改动 | reserved 启用声明（对拍机制现成） | 双端新采样路径 |
| 方向锐度 | L1（漏光大尺度差足够） | 32 方向（镜面级锐度） |
| 工作量 | 1×（约 1 天含对拍） | 3–4× |
| 堵 B？ | 否（可叠加） | — |

**推荐 A 先行**：intFloorBack 漏光是上/下半球尺度方向差，L1 足以表达；零新资源零新绑定把验证面压到最小；B 作为锐度不足时的叠加项保留。

## 5. 拍板清单（确认后开工，估时 A=约 1 天）

1. 批准方案 A（reserved 启用 RGB L1 SH 方向可见度）与 native reserved 合同同步启用声明；
2. 批准镜面消费侧可见度语义从全域标量切到 L1 方向（f5-variant-semantics 裁定的标量门降级为 fallback：SH 缺失探针按标量门）；
3. 验收门确认：intFloorBack leakRatio ≤1.1（32 方向 CPU 参考）+ 白炉逐位负控 + Chebyshev 方向性验证。

任一项不批准则维持现状（标量门，intFloorBack 门保持未达如实登记），不影响其余 60 项。
