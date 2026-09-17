# 3DM 圆柱源曲面重建

日期：2026-09-17。已完成矩形裁剪圆柱切片；任意曲面裁剪仍为本轮待办。

复用已有 NURBS/Bézier 凸包细分，将求值维度从 UV 扩到 3D，并保留每个离散点对应的源参数。
圆柱需要原 openNURBS `IsCylinder` 身份、参数一致的正权重 NURBS、一个一次轴和一个二次轴。
两行控制网格必须逐点具有相同平移及权重，平移与源圆柱轴平行；因此沿高度方向无需细分。
矩形 trim 可以是原参数域的子域，顶点仍从源 surface 求值，source face index 保留。

源空间默认弦差预算为 0.01 源单位。正权重 Bézier 控制凸包到弦段的距离界，
对平移后的每个截面继续成立；三角形覆盖实际矩形裁剪带，不添加顶底盖。
完整周期截面共享接缝索引，部分圆柱保持其源边界开放；法线尊重 U/V 方向、转置和 face reversed。
自然矩形边界核验从球面实现抽出复用，缓存优先规则不变。

## 真实语料与结果

从本机已固定 McNeel 官方样本检查 MechPartA、MechPartB 与 V2 UntrimmedSurfaces。
MechPartA 的作者圆柱 trim 非矩形，继续拒绝；本片固定
[V4 MechPartB](https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm)：
archive version 4，毫米，SHA-256
`848271e98cf83a72c6d0fa134dc7a430d2f4d938a4c38765dcc6da0bff8d8978`。
样本仅本地验证，不提交或再分发；使用边界沿用既有 openNURBS 样本审计。

| 源面 | 重建顶点/三角 | 原 PointAt 参考点 | 到实际三角网格最大距离 mm | 控制凸包界 mm |
| --- | ---: | ---: | ---: | ---: |
| 4 | 18 / 16 | 196 | 0.00134265 | 0.00276697 |
| 5 | 18 / 16 | 224 | 0.00253146 | 0.00533314 |

两面的源圆柱支撑残差不超过 `7.328e-15 mm`。按三角形计算的法线与源方向一致，
边相邻计数与开口矩形带 Euler=1 通过。参考距离由原 openNURBS `PointAt` 与 Three Triangle
独立最近点计算，不通过待测离散器反推。

审核模式忽略保存网格，整个文件重建 10/14 面（含原平面能力）、216 顶点/196 三角，
保留 `partial-geometry-preview`。GLB source map 的两个圆柱 face index 与输入一致；
GLB SHA-256 `d633f278a922564b2cff6c65e4f695591053623a66a9357dca3efa812b23575e`。

完整周期接缝使用真实 MechPartA 源圆柱加**受控自然矩形 trim**测试，验证 Euler=0、
仅上下边界开放；该控制不计为 MechPartA 作者裁剪支持证据。

## 验证与剩余

```powershell
cmd /c scripts\fixtures\build-3dm-source-audit.cmd
pnpm exec tsx --test scripts/fixtures/3dm-cylinder-tessellation.test.mts
pnpm exec tsx --test scripts/fixtures/3dm-trim-polyline.test.mts scripts/fixtures/3dm-sphere-tessellation.test.mts scripts/fixtures/3dm-planar-trim.test.mts scripts/fixtures/3dm-glb-export.test.mts
node scripts/fixtures/audit-3dm-source.mjs
pnpm exec tsx scripts/fixtures/audit-3dm-glb.mts
pnpm gate:repository
```

圆柱 4/4、既有回归 17/17、5 件源/GLB 审计、专项 tsc、repository gate 与本片 diff-check 通过。
拒绝路径覆盖伪半径、缺支撑、缺 trim 与精度预算耗尽；三维多项式参数回拍、面反向与转置通过。
审核 EXE SHA-256 `c616432d8faba8cc487c841aa9babdff7e5a33c25f928037d6bb862e5448fcbd`；
`test-output/3dm-source-audit/cylinder-evidence.json` SHA-256
`af89e3ac8cd2bd3215428856c2217dd7508000a30171ccc07f5e60f1ae7de3f5`。

未引入第三方依赖。任意圆柱 trim、非平移控制网格、其它参数映射、跨面缝合、
源精度策略、Web/Native 产品接线与浏览器视觉继续待办；不提升生产 profile。
