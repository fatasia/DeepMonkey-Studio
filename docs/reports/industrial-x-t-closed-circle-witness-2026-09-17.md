# X_T 无顶点闭圆边界见证

强化审核暴露了之前未测到的边界弦差。相同 109 件不可变 GLB，结果由 `19203 matched / 1 mismatch / 140 unresolved` 变为 **`19086 matched / 252 mismatch / 6 unresolved`**。这不是转换几何回归：源文件和 GLB 哈希均未改变；变化来自新增独立源边界见证。

## 新见证

源 LOOP 只有一个 FIN、正反链接都回到自身且 VERTEX 为 0 时，读取其 EDGE 的直接 CIRCLE。用源中心、轴、参考方向和半径生成 16 个圆周见证点，米转毫米后比较到实际 GLB 三角集合的最短距离。

不把 TRIMMED_CURVE 或多边环的圆弧扩成整圆；非法半径、退化/不正交坐标架不修补。数学实现只依赖原始 parser，不链接转换器几何库。

这补齐了 134 个原先没有顶点和解析曲面见证的面：70 个匹配，64 个超差。另有 187 个此前只测顶点/曲面方程的面暴露边界超差，原交线 mismatch 保留，因此总差异为 252。

新增差异以离散弦差为主：全部差异中 247 个边界最大值低于 `0.02 mm`；最坏 AS-0820 face 10672 为 `0.0488295413 mm`。固定预算仍为 `0.01 mm`，不能放宽以保留旧结果。圆环面顶点在源曲面上，并不能证明圆形边界到弦的距离足够小。

## 下一修复入口

研究 runner 当前只传 `--quality plain`，其相对 deflection 与模型尺度相关，没有落实固定毫米预算。现有 CLI 已支持 `--sag` 并将其解释为绝对毫米，下一片固定为 `0.005 mm` 后重转全部 109 件，再跑本审核。此报告不预判重转后的差异数。

剩余 140 项的初始分型为 113 CONE、3 非环形 TORUS、14 SWEPT_SURF、6 SPUN_SURF、4 B_SURFACE。圆锥公式试验发现旧参考约定与这批源顶点的方向不一致，因此没有把该候选公式的差异当转换器错误，也没有选择“更易通过”的输出符号；本片使用独立源 CIRCLE 避开该未校准约定。圆锥方向仍需版本与源几何证据。

## 验证与证据

- 新增 circle 数学/无效数据单测 2/2；既有审核 9/9。
- 独立 oracle 实际编译、109 件全量哈希和几何审核完成；剩余 mismatch 使审核按约定非零退出。
- rustfmt、diff-check 和 repository gate 通过；没有新增产品依赖，模型/GLB 不入库。

```powershell
node scripts/audit-xt-face-geometry.mjs test-output/xt-face-geometry-oracle-circle.exe test-output/xt-native-sp-analytic/evidence.json data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges test-output/xt-face-geometry-circle.json
```

| 工件 | SHA-256 |
|---|---|
| 原转换 evidence.json | `e8809225e0dd9f38f33f12d797d7e28d2ea9678ef8dd78a2847a22174bd74442` |
| 闭圆 oracle | `c8869e3e362a5b8f893f16f993029c0e20202c06a87f1bdc1f54a8dba7288741` |
| 强化审核结果 | `9b449a0364ebb40d583465d8e2abbea0d31d7a76b9ff339f7ca3292bfcb8590d` |

旧“1 mismatch”仅为历史窄见证结果，不再作为当前完整审核进度。生产 profile 仍为 0。
