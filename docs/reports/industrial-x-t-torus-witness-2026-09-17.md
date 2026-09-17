# X_T 环形圆环面独立见证

补齐源 TORUS 方程审核后，109 件既有不可变 GLB 的逐面结果为 `19203 matched / 1 mismatch / 140 unresolved`。此前 181 个 unresolved 中，11 个文件的 41 面取得独立解析曲面见证。本片只增强审核，没有改变转换几何；生产 profile 仍为 0。

## 实现

只链接 `xt-parser` 的原始见证程序直接读取 TORUS 的中心、轴、主半径和管半径；不调用 `cad-xt` 的几何求值或离散器。Node 审核器对真实 GLB 面区间的每个顶点计算：

```text
axial = dot(point − center, normalizedAxis)
radial = length(point − center − axial × normalizedAxis)
residual = abs(hypot(radial − majorRadius, axial) − minorRadius)
```

仅接受 `majorRadius > minorRadius > 0` 的环形圆环面；horn/spindle 形式保持未支持，不套用错误分支。固定 `0.01 mm` 门槛与既有 Float32 量化预算不变。

没有拓扑顶点的闭合环面此前缺少任何见证，并不代表转换器没有生成几何。新增公式同时强化了原本只有边界见证的 204 个环面：共 245 个真实源 TORUS 全部通过，最大顶点残差 `0.0091478866 mm`；新取得见证的 41 面最大残差 `0.0000028477 mm`。

首个实测 A-6361 face 740，源 surface 410 的主半径为 `0.4 mm`、管半径为 `0.1 mm`，598 个 GLB 顶点最大残差 `0.0000002247 mm`。原有 AS, AT-2810R face 360 mismatch 仍保留，未改变分类或预算。

这只证明输出顶点贴合对应解析曲面，不证明整个曲面的覆盖完整、孔洞拓扑、三角内部弦差或唯一身份；这些仍需独立见证。

## 验证

- `node --test scripts/audit-xt-face-geometry.test.mjs`：9/9。新增环面双半径、轴向旋转/反向/非单位轴、填入中心错误点、预算内外、错误半径和无效/不支持形态。
- Rust 只链接 parser 的 oracle 实际构建通过；rustfmt、diff-check、repository gate 通过。
- 全部 109 件源哈希、GLB 哈希及 faceRange 对应关系重新审核；逐面命令按现有非零约定报告剩余 1 个 mismatch，而不是全绿退出。

```powershell
node scripts/audit-xt-face-geometry.mjs test-output/xt-face-geometry-oracle-torus.exe test-output/xt-native-sp-analytic/evidence.json data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges test-output/xt-face-geometry-torus.json
```

| 工件 | SHA-256 |
|---|---|
| 输入转换 evidence.json | `e8809225e0dd9f38f33f12d797d7e28d2ea9678ef8dd78a2847a22174bd74442` |
| 独立 oracle | `87e7c39819d68b25395a604fd59e40de6108c00970e552c6905a0877f11ee712` |
| 逐面结果 | `4b3929500eb3c55b99dc3f0bd1e06e32b31fce0b26e5be80615caab292e43338` |

原模型和 GLB 仍只在本地忽略目录。剩余 140 个无见证面需要继续读取其他曲面或边界，不以本片扩大生产声明。
