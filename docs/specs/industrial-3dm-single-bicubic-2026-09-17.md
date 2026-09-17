# 3DM 单块双三次曲面

日期：2026-09-17。MechPartB 无缓存重建增至 13/14 面，仍为部分预览。

## 受限合同

只接受 identity 参数、非有理、双三次 4×4 控制网，两轴均为夹持单段 Bézier。
原圆柱中的 UV 裁剪与边界细分抽出为共享 `3dm-trim-grid.mts`；圆柱用一轴条带，
双三次用两轴网格。共享闭环、孔洞、交叉、面积、源边和共线接点校验，不另建一套 trim 解释器。
导出位置继续由原 source surface 求值，法线由原控制网的一阶导数叉积计算。
有理或多段曲面仍拒绝，不因近似看起来正确就扩大合同。

二阶导数控制网在整个参数域给出连续凸包界 `Muu`、`Muv`、`Mvv`。
每个参数网格内的三角插值界为
`(Muu*du² + 2*Muv*du*dv + Mvv*dv²) / 8`。
它来自 Taylor 余项与顶点参数方差上界，包含混合导数项；不以单一中点误差代替曲面上界。
一阶导数界控制 trim 的参数域误差到源空间的传播。

沿用 0.01 mm 源局部物理预算：10% trim、70% 曲面插值，剩余预算用于参数去重和
Float32 量化。细分上限 256×256，裁剪顶点/三角预算分别为 100000/200000，超出时拒绝。
顶点奇异法线、翻转/退化三角、非有限控制点、未知单位和非法 knot 均拒绝。

## 真实证据

固定 [openNURBS V4 MechPartB](https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm)，
SHA-256 `848271e98cf83a72c6d0fa134dc7a430d2f4d938a4c38765dcc6da0bff8d8978`。
archive V4、毫米；沿用既有官方样本使用边界，仅本地验证，不提交或再分发源文件。

新增 face 3：10×10 参数网格、121 顶点、200 三角，252 个原 openNURBS PointAt 内域
参考到实际网格最大距离 `0.002131028 mm`，含量化总界 `0.007544365 mm`。
二阶导数范数界按 uu/uv/vv 为 `1.425332 / 1.843361 / 3.691855` 源单位/参数平方。
源边全部对应实际三角边，面内无 T 接点，Euler=1；三角方向与源法线点积大于 0.95。

完整研究预览 GLB 为 13 primitives / 755 顶点 / 995 三角，产品结构审核及 source face 3
映射通过。face 1 的 12×12 多段双三次网仍未支持，不宣称完整闭壳。

44 项专项与历史回归、专项 TypeScript 和 repository gate 通过。受控孔洞保持空缺，反向面
翻转法线；多段、有理、坏 knot、未知单位、奇异支撑与过紧预算反例均拒绝。
共享 UV 实现抽取后的圆柱/圆锥/源边容差回归通过，MechPartA 覆盖仍为 17/41。

独立目录 `test-output/industrial-3dm/single-bicubic-2026-09-17-v1/`：

- `evidence.json` SHA-256 `cea9db2053b584fa84b7b3896a7d423431d51ced14ca6bad287918c065888180`
- `MechPartB.glb` SHA-256 `f617075df4f0a625bc9daf0bcdf0465467808f61cb47c86c34972c7fb0d9e602`

既有回归产物也使用该目录各子目录；之前切片目录和历史 hash 保留不覆盖。
复跑：`pnpm exec tsx --test scripts/fixtures/3dm-bicubic-face.test.mts`。
没有新增依赖、商业 SDK 或源 CAD 软件。

多段双三次、曲面之间的共边一致离散、实例世界精度、产品接线与视觉仍待办。
未执行浏览器双轮截图与 design-taste-digitaltwin 十维评分，不提升生产或视觉状态。
