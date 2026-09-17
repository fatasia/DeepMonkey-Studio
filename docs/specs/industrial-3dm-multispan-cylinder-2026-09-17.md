# 3DM 多段一次轴圆柱

日期：2026-09-17。MechPartB 无缓存重建从 10/14 增至 11/14 面；仍为部分几何预览。

## 支持边界

新增第 11 面：圆柱的二次轴保持原正权有理 Bézier 表示，一次轴有四个控制点、三个 knot 区间。
不是通用 NURBS 新解码器：只有能够证明全部区间共享同一仿射平移与参数速度时才接受。
离散仍复用非矩形 trim、孔洞、参数条带、源边编号和物理预算合同。

一次轴 knot 必须夹持、内部严格递增，原 domain 与 knot 有效域完全一致。
以首行控制网和首末轴向平移构造等价控制网；用原线性 knot 对应的参数比例定位中间行。
正权基函数组成单位分解，故可分别界定齐次分子偏差和权重偏差：
`surfaceDifference <= (maxNumeratorDifference + maxIdealRadius * maxWeightDifference) / minWeight`。
计算在局部原点下进行，另计浮点保护；等价界大于 `1e-9` 源单位就拒绝。
该比较只用于证明，输出顶点仍从完整原 source surface 求值，不替换或修改源控制点。

曲面插值和 trim 映射两条误差路径各计入两次等价界，总预算新增 `4 * equivalenceBound`。
这覆盖源→等价面和等价网格→源顶点的误差，不把同一个预算重复借给其它步骤。
最终仍要求源局部物理误差总界不超过 0.01 mm；实例世界空间精度尚未验收。

## 真实证据

输入 [openNURBS V4 MechPartB](https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm)，
SHA-256 `848271e98cf83a72c6d0fa134dc7a430d2f4d938a4c38765dcc6da0bff8d8978`。
archive V4，毫米。官方样本沿用既有使用边界，仅本地验证，不提交或再分发源文件。

第 11 面为 202 顶点 / 297 三角；207 个原 openNURBS PointAt 内域参考点到实际三角网格
最大距离 `0.001278479 mm`。轴等价界 `2.514e-13 mm`，含 trim、插值、量化、参数去重、
轴等价的总界 `0.007316896 mm`。实际源边全部对应输出三角边，面内无 T 接点或退化三角。
GLB 为 11 primitives / 466 顶点 / 541 三角，保留第 11 面源索引，产品结构审计通过。

3 项新增测试与 36 项既有回归通过，专项 TypeScript、repository gate 通过。
负例分别改变中间控制点、权重、knot 连续性和参数位置，均拒绝；转置 U/V 后原源位置一致，
参数方向翻转导致法线方向对应翻转。MechPartA 仍为上一片的 14/41 面，输出证据 hash 不变。

独立目录 `test-output/industrial-3dm/multispan-cylinder-2026-09-17-v1/`：

- `evidence.json` SHA-256 `802d1314b90ef8b17c6c793751bb60ff5b9e2ac7cfbf6e0005ee253385e6b9c9`
- `MechPartB.glb` SHA-256 `aa14988098487a0fc7273f3aa22cfdca825a2f9149c28c399bab1a880b110a91`

MechPartB 整体 GLB 改变，因此既有 natural cylinder、boundary 和 source-edge 回归输出分别迁入
该目录的 `natural/`、`boundaries/`、`source-edge/`，不覆盖 `cae20e7` 历史证据。
旧规格中的历史 hash 不变，新复跑结果按本片目录读取。

复跑：`pnpm exec tsx --test scripts/fixtures/3dm-cylinder-axis.test.mts`。
未引入第三方依赖、商业组件或源 CAD 软件。

剩余 MechPartB 三个一般曲面、跨面共边细分、周期缝索引合并、实例误差和产品视觉继续待办。
未进行浏览器双轮截图，design-taste-digitaltwin 十维视觉评分仍未验收，不提升生产状态。
