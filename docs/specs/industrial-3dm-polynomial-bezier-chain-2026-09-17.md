# 3DM 非有理双三次 Bézier 链

日期：2026-09-17。MechPartA 无缓存重建从 29/41 提高到 33/41 面；仍为部分预览。

沿用正权有理链内核，把非有理控制点转为权重恒为 1 的齐次控制点，控制网提取按次数
计算步长。没有另写求值、trim、细分或误差算法。支持 identity 参数、夹持端点、内部
结点重数为 3 的双三次链；内部结点为简单结点的 C2 曲面继续走原路径。

本片新增 face 5/6/7/8，均为 4×25 控制网、8 个原 Bézier 子网。全部源 knot 加入网格，
三角形不跨结点；权重导数恒零，商法则界自然退化为多项式导数控制凸包界。
保持 0.01 mm 源局部物理预算、孔洞、方向、源边身份和量化成本，不扩大任何源声明容差。

固定 [openNURBS V4 MechPartA](https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm)，
SHA-256 `a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31`；
archive V4、毫米，官方样本只做本地验证，不提交或再分发源文件。

每面 1089 顶点、2048 三角。1008 个原 openNURBS PointAt 内域参考至实际网格最大距离
`0.001004582 mm`，各面连续总界均小于 `0.007988410 mm`。
所有源边段都是实际三角开边，面内 Euler=1；三角方向与三个顶点源法线一致。
整件 GLB 为 33 primitives / 24829 顶点 / 44104 三角，结构审核通过，源面映射准确。

38 项针对性回归、专项 TypeScript、repository gate 通过。验证每个源跨度的解析切向量、
孔洞、反向面、未知单位、错误结点、非有限控制点及过紧精度；源 CadIR 不修改，保存网格
清空后导出。MechPartB 14 面及其 GLB/源边冲突证据保持不变。

独立目录 `test-output/industrial-3dm/polynomial-bezier-2026-09-17-v1/`：

- `evidence.json` SHA-256 `5b77a84672bdec358cebe665c27e58ea11fc808b75d0f9a03dcf3c3aeafc85f3`
- `MechPartA.glb` SHA-256 `5ce8d5ded681607e4c3eaabdbced9565d266e51f44b109993492d5faaa469de4`

A 的旧有理链与圆柱整件回归产物移至本目录子目录，历史目录及 hash 不覆盖。
复跑：`pnpm exec tsx --test scripts/fixtures/3dm-polynomial-bezier-face.test.mts`。
剩余 8 面为多段二次×一次圆柱候选；跨面共边、世界精度与产品接线仍待办。
没有新增依赖；未执行视觉截图验收，不提升闭壳、生产或视觉状态。
