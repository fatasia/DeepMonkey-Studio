# 3DM 无缓存球面离散

日期：2026-09-17。已完成完整自然边界球面切片；一般裁剪曲面仍为本轮待办。

读取器通过原 openNURBS `IsSphere`（识别容差 1e-10）保留球心和半径。
离散器同时要求已验证的可分离圆弧参数映射、完整 2π×π 参数域与四条自然边界，
所有顶点都经原参数→NURBS 参数→曲面求值得到。球心/半径仅用于误差审核和法线，
不替代源几何求值。任意裁剪球面、未知映射和曲面身份不一致都拒绝。

面法线尊重原 U/V 方向、转置与 face reversed。周期接缝共享索引，两个极点各为一个顶点，
避免极点退化三角；既有保存网格仍优先。分派器从平面模块独立出来，集中维护缓存优先、
面级诊断与支持类型，不在 GLB exporter 复制判断。

## 误差与真实文件

当前研究预算为 `0.01` 源单位，两件样本均为毫米。
球面角参数的二阶导数范数不超过 R；三角重心插值的方差给出
`R/8 × (Δu+Δv)²` 点误差上界。按该上界选择分段数，最多 300,000 顶点，超限明确拒绝。

| 真实样本 | 重建顶点/三角 | 误差上界 mm | 原 PointAt→网格插值最大误差 mm | 三角中心径向误差 mm |
| --- | ---: | ---: | ---: | ---: |
| blocks.3dm | 7,262 / 14,520 | 0.0098771 | 0.0049779 | 0.0043888 |
| sphereDecals.3dm | 53,303 / 106,602 | 0.0099234 | 0.0051041 | 0.0044103 |

每个网格的全部边恰有两个 incident triangles，Euler 特征数 2；所有三角绕序与输出法线一致。
源球面参考点半径残差不超过 `2.132e-14 mm`，NURBS 重建顶点支撑球残差不超过 `5.685e-14 mm`。
原 `PointAt` 对照使用逐参数参考，独立映射到网格单元并插值，不只检查球半径。

blocks 文件没有保存球面网格，现可输出研究 GLB；两个真实块引用共享一个生成 mesh。
GLB 354,084 bytes，SHA-256 `3fcde735a952873adf552d1292b46e550451cfdd3c1cbc4ac9c137eda9cc1968`。
sphereDecals 的重建仅作直接离散器对照，默认导出继续消费其已保存网格。
来源/源 SHA/使用边界沿用[原 CAD IR 证据](industrial-3dm-cad-ir-2026-09-17.md)。

## 验证和限制

MSVC 重建、5 件真实源读取与 GLB 二进制 audit、球面测试 4/4、原平面/trim/GLB 回归 13/13、
参数映射 5/5、专项 tsc、repository gate、本片 diff-check 通过。
失败项覆盖缺 analytic support、伪半径、部分边界和过精预算；额外覆盖面反向与参数转置。

```powershell
cmd /c scripts\fixtures\build-3dm-source-audit.cmd
node scripts/fixtures/audit-3dm-source.mjs
pnpm exec tsx --test scripts/fixtures/3dm-sphere-tessellation.test.mts
pnpm exec tsx scripts/fixtures/audit-3dm-glb.mts
```

`test-output/3dm-source-audit/sphere-tessellation-evidence.json` SHA-256：
`ee8c32e646aebe18843664f40902632cfd7cbf94961f967301784773729c6a0f`。
无商业 SDK 或新增第三方依赖；仍为研究预览。圆柱、一般 NURBS、任意曲面 trim、跨面缝合、
容差按源文件配置、浏览器视觉与生产接线均未计作完成。
