# 3DM 未标注圆柱的控制网证明

日期：2026-09-17。MechPartB 增至 12/14 面，MechPartA 增至 17/41 面，仍为部分预览。

## 源分类

上一片后 MechPartB 剩三面并非同类：face 1 是非有理双三次 12×12 多段控制网；
face 3 是非有理双三次 4×4 单块；face 2 是正权一次×二次 3×3 控制网。
face 2 的源 `analyticSupport` 为 null，但具有可证明的圆弧平移结构。
同族排查也找到 MechPartA 的 face 1/2/3。没有据文件名、包围盒或视觉形状推断几何。

## 连续证明

先复用一次轴全部控制行的仿射参数等价证明；二次轴只接受单段夹持正权二次 Bézier。
用两个端点和中点构造候选圆，再验证整个有理曲线，而不是把三点拟圆当作完成：

`Q(t)=A(t)-center*w(t)`，将 `dot(Q,Q)-radius²*w²` 展开成四次 Bernstein 的五个系数。
系数最大绝对值界定整条曲线的平方半径偏差；再除以 `minWeight²*radius` 得径向界，
同时核对圆弧控制网与轴向正交平面。上界大于 `1e-9` 源单位就拒绝。
正权、knot/domain、齐次权重与轴证明均保留门槛。

原 source IR 不修改；圆柱身份作为 `derivedSupport` 单独记录，保留
`sourceAnalyticSupport:null` 和全部证明系数。所有输出位置仍由原完整 source surface 求值。
现有 trim/条带/量化合同继续负责几何误差；尚未计入轴证明的双行控制网追加四倍轴等价界。
没有转化为通用 NURBS 或提升生产 profile。

## 真实证据

输入为固定 openNURBS V4 官方 [MechPartA](https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm)
和 [MechPartB](https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm)，毫米。
源 SHA-256 分别为 `a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31`
及 `848271e98cf83a72c6d0fa134dc7a430d2f4d938a4c38765dcc6da0bff8d8978`。
沿用既有官方样本使用边界，仅本地验证，不提交或再分发源文件。

| 新增面 | 顶点 / 三角 | 原 PointAt 数 | 最大距离 mm | 物理总界 mm |
| --- | ---: | ---: | ---: | ---: |
| A:1 | 417 / 661 | 31 | 0.002566736 | 0.007753526 |
| A:2 | 417 / 661 | 31 | 0.002566736 | 0.007753526 |
| A:3 | 417 / 661 | 31 | 0.002566736 | 0.007753473 |
| B:2 | 168 / 254 | 217 | 0.001278479 | 0.007316900 |

四面的连续圆弧径向界均小于 `1.17e-13 mm`。源边均对应真实三角边，面内无 T 接点，
无退化三角，source face map 保持。GLB A 为 17 primitives / 7369 顶点 / 10912 三角，
B 为 12 primitives / 634 顶点 / 795 三角，产品结构审核通过。

41 项专项与回归测试、专项 TypeScript、repository gate 通过。负例保持平移结构但移动
有理中间行，三点仍可拟圆，整条曲线的多项式证明正确拒绝；未知非有理曲面保持拒绝。

独立证据目录 `test-output/industrial-3dm/proven-cylinder-2026-09-17-v1/`：

- `evidence.json` SHA-256 `87ecd549f63764205f42bcdae3e1bd3f244c6b26ead3a6b085a56ef79048491a`
- `MechPartA.glb` SHA-256 `15122b783efa326a2858ed4333fd2d4e2522b3948a6df7f506ae397b98fad07c`
- `MechPartB.glb` SHA-256 `2cdc53f0c1ebfec85889713f49494d2a922d2d190fe47b53d4a43f5733b840b3`

改变整体 GLB 的既有回归证据一并迁到该目录子目录，之前两片目录与历史 hash 不覆盖。
复跑：`pnpm exec tsx --test scripts/fixtures/3dm-proven-cylinder.test.mts`。
没有新增依赖、商业组件或源 CAD 软件。

剩余 B 双三次两面、A 24 面、完整跨面边界、实例世界精度和产品视觉仍待办。
未执行浏览器双轮截图与 design-taste-digitaltwin 十维评分，不宣称视觉或生产完成。
