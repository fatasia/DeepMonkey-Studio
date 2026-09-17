# 3DM 真实孔洞与有理 trim

日期：2026-09-17。已完成真实平面曲线 trim 切片；一般曲面仍为本轮待办。

离散器扩展到正权重、clamped NURBS trim（次数 1～8）：插结点拆成有理 Bézier，
按控制凸包到弦段距离递归细分，再复用既有孔洞三角化与交叉/面积检查。
凸包上界通过仿射面 Jacobian 范数转成源空间预算，固定 `0.001` 源单位；
拒绝非正权重、内部断裂、不支持的参数映射以及深度/顶点预算超限。
没有引入新的库，也没有读取显示网格来生成重建三角形。

## 语料与使用边界

先检查 `D:/Download`（未发现 `.3dm`），然后在已固定 openNURBS 缓存找到：
[McNeel v8.35 官方 v4_MechPartA.3dm](https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartA.3dm)。
它是实际机械零件文件，archive version 4，毫米单位，41 面/41 保存网格。
源 SHA-256 `a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31`。
本片仅本地验证，源模型不提交；逐文件再分发审计完成前不打入产品样例。
包来源、版本和许可证文本沿用已固定 openNURBS 依赖清单，不要求用户商业许可。

审核模式显式忽略 41 份保存网格以证明源曲面/trim 重建，源文件保持只读：

- 重建 10/41 面，2458 顶点/2450 三角；5 面共 6 个真实孔，其余 31 面保留逐面诊断与 `partial-geometry-preview`。
- 使用原 openNURBS `PointAt` 新增可选全参数证据；独立 NURBS 求值最大误差 `5.403e-15 mm`，原 trim 参考点到离散弦最大 `0.000335 mm`。
- 单圆环面的面积另由原参考点拟合圆并核验全部参考点计算；例如 face 11 解析面积 `2.1676989309769734 mm²`，离散面积差 `0.0001230498 mm²`，在周长×弦差预算内。
- GLB SHA-256 `043dc8c4265230f2f8d9b4a3dafdde3cccfcffa3cbacd4d6544d5fc6a0792dee`。孔洞误差为有界近似，不宣称离散边界与解析圆完全重合。

镜像 `(-2,3,0.5)` 与非均匀缩放 `(1,2,4)` 是作用于上述真实几何的**受控实例变换**，
不是文件内作者原有实例。导出后的矩阵逐元素对拍、行列式符号与共享单 mesh 通过；
实际浏览器中的镜像剔除/照明仍待产品视觉验收。

## 复验与剩余

```powershell
cmd /c scripts\fixtures\build-3dm-source-audit.cmd
pnpm exec tsx --test scripts/fixtures/3dm-trim-polyline.test.mts scripts/fixtures/3dm-planar-trim.test.mts scripts/fixtures/3dm-glb-export.test.mts
pnpm exec tsx scripts/fixtures/audit-3dm-real-trims.mts
pnpm gate:repository
```

13/13 测试、实际源重读确定性、原 PointAt 对照、GLB 审计、专项 tsc、repository gate 通过。
有理混合结点、裁剪子域、反向、权重错误、结点错误和预算耗尽都有测试。
`test-output/3dm-source-audit/real-trim-evidence.json` SHA-256：
`ca99905a7865a5dc1826cf3fc8f671d38d52651fe6d6f0fadded527acb068844`。

该工具尚未生产注册；球面/圆柱/一般 NURBS 曲面离散、精度预算按源容差配置、
源作者镜像实例矩阵、闭合性和浏览器双轮视觉仍待验收。
