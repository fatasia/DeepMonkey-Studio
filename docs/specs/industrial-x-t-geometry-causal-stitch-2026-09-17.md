# X_T 逐面差异归因与拼接修复

2026-09-17。面向本地自研/开源研究链路；109 件仍为 preview，未认证生产 profile。

原始 12 处逐面差异中，3 处来自三角网格拼接，已修复；4 处涉及面重建，5 处已在缓存边界折线出现。复跑后为 19,154 面见证通过、9 面差异、181 面证据不足，共 19,344 面。没有放宽 0.01 mm 检查阈值。

## 方法与判别边界

独立比较依据是 `xt-face-geometry-oracle.rs` 直接从原始实体字段读取的边界点与解析曲面，不调用 cad-xt lowering。`xt-face-causal-probe.rs` 则读取 lowering 后的曲面、缓存边界与单面离散结果，仅用于定位差异出现在哪一阶段，不能代替原始真值。

诊断比较单面离散结果与最终 GLB faceRange 的唯一 Float32 顶点集合。9 个问题面的两集合完全相同，问题已在拼接/导出之前发生；另 3 个面单面结果合格、最终结果不合格。结合拼接候选检查和修复后的同源回归，定位后者为拼接缺陷，而非 faceRange 标签错位。

涉及圆柱面的原始轴、原点、半径与 lowering 参数一致；原始边界点的曲面残差远小于对应缓存折线残差。这排除了这些实例的整体单位/轴换算错误，但不构成对所有解析曲面 schema 的证明。下表差异均不能用 Float32 舍入解释。

## 12 面分类

数值单位均为 mm；面编号为原始 FACE handle。边界距离指原始边界点到三角形的最短距离，曲面残差指三角顶点到原始解析支撑面的距离。

| 模型 / FACE | 阶段 | 数值证据 |
|---|---|---|
| A-1811 / 1199 | 面重建 | rebuilt=true；单面边界距离 0.434147 |
| A-1821 / 226 | 面重建 | rebuilt=true；单面边界距离 0.431180 |
| AA-0220LB / 244 | 面重建及折线 | 单面曲面残差 1.371319；缓存边界残差 0.056028 |
| AA-0220LB / 438 | 面重建及折线 | 单面曲面残差 2.841268；缓存边界残差 0.056251 |
| AA-0222B / 5108 | 缓存折线 | 单面残差 0.019648；Polyline edge 338/339 |
| AA-0222B / 10980 | 缓存折线 | 单面残差 0.019648；Polyline edge 75/76 |
| AS, AT-2810L / 1524 | 缓存折线 | 单面残差 0.137900；Polyline edge 6 |
| AS, AT-2810R / 1641 | 缓存折线 | 单面残差 0.137900；Polyline edge 6 |
| AS, AT-2810R / 360 | 缓存折线 | 单面残差 0.044160；Polyline edge 21 |
| AZ-0621,AZ-0622 / 674 | 拼接，已修 | 拼接前残差 0.000002790；原 GLB 0.015587 |
| AS, AT-2810L / 1263 | 拼接，已修 | 拼接前残差 0.000553269；原 GLB 0.022914 |
| AS, AT-2810R / 82 | 拼接，已修 | 拼接前残差 0.000553269；原 GLB 0.022914 |

前四面的 rebuilt 标记和几何差异确证重建结果不满足源几何见证，尚未证明具体选面/参数分支的唯一根因。后五面最坏 GLB 顶点距缓存边界样本不超过约 0.000001 mm，缓存折线本身已偏离原始支撑曲面；还需追溯折线是否来自交线 chart 点或采样曲线 fallback。

## 最小修复

`cad-tess::stitch_t_junctions` 原本只检查候选点与目标三角形边弦的距离是否小于全局 sag，没有检查候选点属于目标面。新增 `stitch_surface::accepts`：候选点在目标曲面的反求/正求残差必须不超过源 solid tolerance 与 Float32 表达误差预算的较大值；无效数值拒绝。候选点不移动、不投影，不补默认几何。

隔离补丁：`scripts/fixtures/cadconvert-xt-stitch-surface.patch`，SHA-256 `2b3361de8ff491cf6b3bbaf418843b14e7356ebeaa7bc7cd5c3ac4acb3e99fbd`。只含新增 helper、模块声明及拼接调用的必要修改，不包含其他 source-map 工作。

验证：cad-tess 单测 36/36；几何见证 JS 测试 7/7；补丁 reverse-check 通过。109 件转换 109 preview、0 failed、109 reported count 一致。19,344 个源面 key 和源几何见证哈希逐项不变，精确消除上表最后 3 个差异，没有新增 mismatch。181 个 unresolved 和 206 个重复源见证仍保留。

## 复跑

诊断工具通过 `rustc --edition=2024 -C lto=thin -C opt-level=3` 编译 `scripts/fixtures/xt-face-causal-probe.rs`，依赖目录为 native `target/release/deps`，显式链接同次构建的 `cad_xt`、`cad_tess`、`cad_ir`、`serde_json` rlib。原始 oracle 同样编译，但只链接 `xt_parser` 与 `serde_json`。禁止混用过期 rlib。

```powershell
node scripts/diagnose-xt-face-geometry.mjs test-output/xt-face-geometry-oracle.exe test-output/xt-face-causal-probe.exe test-output/xt-face-geometry-evidence.json test-output/xt-native-mapped/evidence.json data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges test-output/xt-face-causal-evidence.json
node scripts/audit-xt-face-geometry.mjs test-output/xt-face-geometry-oracle.exe test-output/xt-native-stitch-fixed/evidence.json data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges test-output/xt-face-geometry-stitch-fixed.json
node --test scripts/audit-xt-face-geometry.test.mjs
```

几何审计退出码 2 表示仍有差异，不能作为全通过执行。转换复跑使用 `scripts/verify-xt-native-corpus.mts`，输出目录为 `test-output/xt-native-stitch-fixed`。

| 本地证据 | SHA-256 |
|---|---|
| 修复后二进制 cadconvert.exe | 46e28a1e95d05a187c51432bbca8ee2fa28635b676d76984ca6edc99d51f8973 |
| xt-face-causal-evidence.json | 8390232e2ec6f4dbb3a5fd449ff13edf06ac3685b9ddd4e8d36c0b99d4ece0d6 |
| xt-native-stitch-fixed/evidence.json | 3c5fac1707e581a55c1803eaa8e75f2075307c3de75bf42dc5e092a6d9944f6f |
| xt-face-geometry-stitch-fixed.json | 396b29c0f9fafd374bf1fe136abf7852a6ba5b515dce582cdfb4aa7874b0ed4a |

转换加审计累计耗时从 43.13 s 到 44.14 s。运行期间存在并行任务，这不是受控性能基准。

## 下一修复入口

1. `cad-xt/src/geom.rs` 的 INTERSECTION/chart_points、`sp_curve_polyline`、`sp_curve_polyline_over`，以及 `topo.rs::intern_edge` 的折线 fallback：确认曲线来源，按源公差细化，并同时约束共享边两侧支撑面。禁止分别投影两面的边而制造裂缝。
2. `cad-tess/src/face.rs` 的 `choose_reading` 与边界重建：保留真实支撑面和修剪域，针对前四面建立分支级最小复现，不能把近似重建当作源面精确结果。
3. 当前见证不证明完整修剪域、面间闭合、重合面的唯一身份或装配世界变换；181 面缺证须继续补曲面/环语义。全部证据仅支持研究 preview，不提升发布资格。
