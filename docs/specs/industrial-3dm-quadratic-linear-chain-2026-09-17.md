# 3DM 二次×一次有理曲面链

日期：2026-09-17。MechPartA 无缓存面重建达到 41/41；整件仍为部分预览。

剩余 face 25/26/29/30/34/35/37/39 都是正权有理二次×一次 Bézier 链。
其中前四面含直线跨度，不能统一标为圆柱。复用原正权链内核处理圆弧与直线的组合，
不进行解析圆拟合，也不放宽已有单段圆柱证明。

内核仅新增次数组合与零阶导数规则：子网某轴已为常量时，再求该轴导数得到全零
齐次控制网。其余商法则连续界、源 knot 网格、原 NURBS 求值、trim、源边身份、
法线与 0.01 mm 源局部预算全部沿用。默认入口只接受正权、identity、夹持端点、
对应次数重数的内部 knot；错误权重、未知映射或过紧预算继续拒绝。

固定 [openNURBS V4 MechPartA](https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm)，
SHA-256 `a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31`。
archive V4、毫米；官方样本只做本地验证，不提交或再分发源文件。

1090 个位于真实 trim 内域的原 openNURBS PointAt 参考，至实际网格最大距离
`0.001333427 mm`，八面连续总界均小于 `0.007959087 mm`。
新增 20164 顶点、38454 三角；整件 GLB 为 41 primitives / 44993 顶点 / 82558 三角。
结构审核、源面映射、全 knot 分区、每面 Euler=1、全部源边对应三角边及法线方向验证通过。
孔洞保持空缺、反向面法线翻转；原 CadIR 不修改，清空保存网格后仍能导出全部源面。

完整面数与闭壳分开：当前 69 条跨面边不一致，另有 7 条未验证边，
`allFacesPresent=true` 但边界状态未通过，GLB 保持 `partial-geometry-preview`。
不把这些尚未审核的边一概判为源数据问题；后续按源共边身份及固定预算分别处理。

41 项针对性回归、专项 TypeScript、repository gate 通过，测试约 10 秒。
前两类 Bézier 链及原圆柱保持覆盖；MechPartB 14 面和原 GLB 哈希保持不变。
没有运行无关的 Wheel 大网格整件导出，也没有加入商业回退或新依赖。

独立目录 `test-output/industrial-3dm/quadratic-linear-2026-09-17-v1/`：

- `evidence.json` SHA-256 `59fa42c110012cf9e80a22585c82cc61ec9e9d784579b43bd52a4f986e436004`
- `MechPartA.glb` SHA-256 `f2fc7c8ef131bd4d03a61a970f633b15784f293d13e1860771b3dc66ff3dbe8b`

A 相关历史回归产物迁至本目录子目录，原切片证据不覆盖。
复跑：`pnpm exec tsx --test scripts/fixtures/3dm-quadratic-linear-face.test.mts`。
世界精度、源共边、产品接线及视觉验收仍待办；未执行双轮截图，不提升生产或视觉状态。
