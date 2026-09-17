# 3DM 圆锥台源曲面重建

日期：2026-09-17。研究链路新增矩形 trim 的圆锥台侧面；生产 profile 不变。

## 合同与误差界

原 openNURBS `ON_Surface::IsCone` 提供顶点、单位轴和斜率。实现只接受二次周向、
一次双控制行、正权重 NURBS，两行同权且关于锥顶逐点位似，所有控制点在各自行平面上。
两行必须位于锥顶同侧且高度不同；锥顶奇点、跨顶点曲面及非矩形 trim 明确拒绝。
参数支持 identity 或 separable（角轴 arc-angle、直线轴 identity），含转置。

沿用正权重 Bézier 凸包到弦段的距离界，对完整较大半径行细分；矩形 trim 子域内
所有截面都是该行的缩小位似，误差不增。两条对应弦构成平面梯形，其两三角形覆盖
裁剪带，因此无需沿高度加密。默认弦差为 **0.01 源单位**，不是世界空间误差。
非均匀实例的世界误差上界需乘变换最大奇异值。

曲线细分参数位于 NURBS form 域；角映射用单调二分恢复源参数，再经既有正向参数映射
从实际源 surface 求值顶点。保留周期接缝、源面编号、参数列表、凸包界和支撑残差。
只生成源侧面，不添加端盖；法线与三角方向遵守 U/V、face reversed 和实例变换。

## 真实语料

盘点本机已固定 openNURBS 官方 example_files，MechPartA/B 不含被识别的圆锥面；
Wheel_PG、Gear、PerfumeBottle、disk_brake、Lightbulb 等提供实际候选。
本片固定两个 V4、毫米样本，仅本地验证，不提交/再分发，沿用既有样本使用审计：

| 样本 | 来源 | SHA-256 |
| --- | --- | --- |
| Wheel_PG | [官方文件](https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_Wheel_PG.3dm) | `c116ce1873e6388acbaeb3ccbe08841ed08966db079cd91d492fe621ec127ff9` |
| Gear | [官方文件](https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_Gear.3dm) | `595cb7511020c44e75f93c18f714c71c5b1d36995eab805f5724b4da619b7630` |

Wheel_PG 源面 18/22/24/29/32/35/40/42/46 使用原旋转参数，9 面各 1024 顶点/1024 三角。
2268 个原 openNURBS PointAt 点与独立 Three Triangle 最近点距离最大 **0.004660191 mm**；
源参数映射/求值误差最大 `1.4562e-13 mm`，控制凸包界最大 `0.009515484 mm`。
每面 Euler=0、接缝共索引、仅上下边界开放，无退化三角；法线点积大于 0.99。
源面的 7 个非矩形圆锥 trim 保留诊断。

Gear 有 25 个 identity 参数的窄矩形锥台带通过；84 个落入这些子域的原 PointAt 点
到网格最大距离 **0.004851636 mm**，其余支撑面参考点独立核验参数求值一致。
这是原作者 trim，不是替换成矩形的合成样本。

忽略保存网格的 Wheel_PG 全文件导出有 14 个支持面（含既有平面/圆柱能力），
17416 顶点/17416 三角，状态仍是 `partial-geometry-preview`。
GLB primitive 保留 9 个圆锥 source face、objectId 和源 SHA。
GLB SHA-256 `960bc7f4eccd3078cb658526e181e3d43dc3347fdd7320d4376187f89e439963`。
真实网格上的受控镜像/非均匀实例通过矩阵与共享 mesh 验证；不是源作者实例证据。

## 复现与剩余

```powershell
cmd /c scripts\fixtures\build-3dm-source-audit.cmd
pnpm exec tsx --test scripts/fixtures/3dm-cone-tessellation.test.mts
node scripts/fixtures/audit-3dm-source.mjs
pnpm exec tsx scripts/fixtures/audit-3dm-glb.mts
pnpm gate:repository
```

圆锥专项 5/5、既有几何/GLB 21/21、5 件真实源/GLB 审计、专项 tsc 和 repository gate 通过。
拒绝测试覆盖精度预算耗尽、伪支撑斜率、缺 trim 与锥顶奇点，面反向/转置通过。
审核 EXE SHA-256 `638eb25fd72bb0ee146437961fa8fe3111bb2570f27e10cfbcad5391d6f3563c`。
`test-output/3dm-source-audit/cone-evidence.json` SHA-256
`4083045a037820058c01381fcff28e9a7774203d8a8647b2781189b3676052a0`；
齿轮补充证据为同目录 `cone-gear-evidence.json`。

未新增依赖。一般旋转曲面、带孔/任意曲面 trim、顶点奇点、跨面缝合、源精度策略、
Web/Native 生产接线与浏览器视觉仍待办。
