# X_T 五面缓存折线的来源与失败复现

本轮把五面的误差追到具体原始曲线与 lowering 分支，新增可执行失败检查；没有修改研究解析器、离散器或 release 二进制，未生成几何修复补丁。

## 来源

| FACE / 模型 | 唯一来源与保留粗线的分支 | 缓存残差 mm |
|---|---|---|
| 5108 / AA-0222B | INTERSECTION 5183→CHART 5186、5212→5215，各 6 点；涉及 BLEND_BOUND 5104/5195 | 0.019647502 |
| 10980 / AA-0222B | INTERSECTION 12494→CHART 12497、12435→12446，各 6 点；涉及 BLEND_BOUND 12104/12437 | 0.019647502 |
| 1524 / AS, AT-2810L | EDGE 1558 无自身曲线；FIN pcurve 1564(TRIMMED)→1568(SP_CURVE)→surface 1470(type124)、parameter curve 1570；stand-in 25 点 | 0.137899577 |
| 1641 / AS, AT-2810R | EDGE 1675 无自身曲线；FIN pcurve 1681(TRIMMED)→1685(SP_CURVE)→surface 1587(type124)、parameter curve 1687；stand-in 25 点 | 0.137899577 |
| 360 / AS, AT-2810R | curve 675(TRIMMED)→677(INTERSECTION)→680(CHART)，3 点；支撑面 203(CYLINDER)和36(type124) | 0.044160488 |

type124 是样条支撑面。这些字段由只链接 xt-parser 的新 `xt-polyline-source-probe.rs` 读取；路由由现有 `XT_EDGE_TRACE`、`XT_WALK_TRACE`、`XT_WALK_PROBE` 记录。原始数值和 trace 保存在本地 `test-output/xt-polyline-causal.json`，不分发原始 CAD。

AA-0222B 的四条边全部由 `computed_intersection` 的 `needs_blend && reaches_ends` 提前返回，明确 trace 为 `the chart already reaches this edge's ends`。端点接近不证明内部弦段符合曲面公差；现有设计直接保留了 chart。下一入口是 BLEND_BOUND 接触曲线的共同约束求解，不能把圆柱一侧投影当作完整交线。

L/R 的两个 25 点替代曲线来自 `intern_tolerant_curve → sp_curve_polyline_over`，不是 INTERSECTION chart。该函数的弦差上限写死为 `1e-5 * 20` 米，即 0.2 mm，但仅凭该常量不能证明这两面的唯一数值根因：替代曲线是在 type124 支撑面上采样，需进一步区分支撑面求值、参数曲线求值与弦插值分别贡献多少，并校核另一侧圆柱约束。直接增加样本数尚不足以证明正确。

R/360 的 trace 明确为 `computed_intersection` guard 2：在原有折线上再采样 16 段，用段长度与 `tolerance * 20` 比较，判断“足够细”后跳过求交。此指标不检查支撑面残差。下一入口应以两曲面残差判定是否需重算，再用源 chart 限定交线分支并验证端点，不单独投影该圆柱面。

## 可执行失败检查

`scripts/repro-xt-polyline-residual.mjs` 执行三个真实模型、五个固定面。原始 oracle 提供解析曲面，诊断 probe 提供缓存边界点，两者在固定 0.01 mm 下比较；源码 probe 同时输出原始引用链。报告绑定模型和三个探针二进制 SHA-256。

```powershell
node scripts/repro-xt-polyline-residual.mjs data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges test-output/xt-face-geometry-oracle.exe test-output/xt-face-causal-probe.exe test-output/xt-polyline-source-probe.exe test-output/xt-polyline-causal.json
```

当前五面全部失败，Node 退出码 2；缺参、缺文件、缺引用、空真值或探针错误直接失败。未来修复后同一检查只有全部缓存边界符合 0.01 mm 才退出 0。这只检查五个面的缓存边界，不等于五个完整修剪面的证明。
语料发现限制为 16 层/100,000 条目，跳过符号链接并对 realpath 做根目录包含校验，避免诊断入口沿 junction 或路径逃逸读取语料外文件。

新源码探针编译方式与前一轮 oracle 相同：`rustc --edition=2024 -C lto=thin -C opt-level=3`，输入 `scripts/fixtures/xt-polyline-source-probe.rs`，`-L dependency=<native/target/release/deps>`，显式 `--extern xt_parser=<rlib> --extern serde_json=<rlib>`，输出 `test-output/xt-polyline-source-probe.exe`。不链接 cad-xt。

## 验证与未完成项

探针实际编译运行成功，五项残差与前轮独立几何报告一致，rustfmt 与 diff whitespace 检查通过。本轮没有改变转换结果，未重复运行同一二进制的 109 件转换；上一轮全量仍是 19,154 matched / 9 mismatch / 181 unresolved。4 个 rebuilt 面仍待修，5 个缓存折线面也未关闭。

下一步先在上述精确入口记录“源曲线求值点、弦内插点、两侧曲面残差”三组数值，再实施边级共享曲线求解或自适应采样；修复后必须重新运行 109 件转换和逐面 oracle。不能通过扩大公差、分别投影两侧边界、减少见证或消除 warning 来关闭这五项。
