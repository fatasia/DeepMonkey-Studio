# 3DM 源 3D edge 容差缝合

日期：2026-09-17。研究链路由源 C3 控制平面/圆柱共享边，并对声明容差和几何总预算分别设门槛。

## 预算口径

权威工业计划第 181 行要求按源精度分配预算、禁止多次占用同一误差；该行没有固定
`0.01 mm` 数字。此前 3DM 研究切片使用 `0.01` 源单位，样本恰好是毫米。
本片按本次任务冻结 **0.01 mm 上限**，通过 `metersPerUnit` 换算为源单位；缺少单位时
不启用容差缝合。该上限覆盖本次修复面的原离散、边修正、追加边采样与 Float32 量化。

分别记录三条几何误差路径，取最大值与总预算比较：

- 平面：原 trim 弦差 + 已累计边修正 + 本次修正 + 追加 C3 折线弦差 + 量化。
- 圆柱：原控制凸包离散界 + 量化；圆柱顶点仍由源曲面求值，不偏移到近邻网格。
- 共享边：C3 控制凸包弦差 + 源支撑残差 + 量化。

`edge.tolerance` 是独立附加限制，不能因为总预算还有空间就越过它。
零声明容差仅允许可证明相同的有理 Bézier 控制网，浮点比较保护为 `1e-10` 源单位。
证据标注 `source-local-physical-before-instance-transform`；非均匀实例后的世界空间预算
尚未统一，本片不将局部 0.01 mm 说成整个实例场景精度。

## 可证明的边界修正

范围仅限：已有相邻平面/矩形圆柱、单段正权有理二次 C3、identity 参数。
原 trim 必须单调对应源边，两端点保持，原 source edge 身份不变。
采样取相邻平面和圆柱既有参数的并集，防止加密后产生新 T 接点；平面重新执行完整
裁剪环/孔洞/三角验证，圆柱从原曲面重新求值。任何既有一致共边退化都会拒绝整次修复。

连续容差证明分两种，不用采样最大值代替上界：

1. 同权有理 Bézier 控制网（允许反向）：控制点最大偏差界定整条曲线偏差。
2. 正权控制凸包分段：原 trim 弦差界 + 两条折线对应顶点最大残差 + C3 区间弦差界。
   点对应必须单调覆盖源子域；弦差界来自控制凸包，不来自均匀点抽查。

每次修复保留源 face/edge/trim、C3 参数、两侧支撑残差、连续容差证明及总预算分项。
GLB primitive 的 `tessellationAudit.sourceEdgeWelds` 与 sidecar `boundaryAudits.welds`
保留记录，原 sourceSha/objectId/face index 不变。

## 真实证据与明确反例

固定 [MechPartB V4](https://github.com/mcneel/opennurbs/blob/v8.35.26251.13001/example_files/V4/v4_MechPartB.3dm)，
SHA-256 `848271e98cf83a72c6d0fa134dc7a430d2f4d938a4c38765dcc6da0bff8d8978`；
本地验证，不提交/再分发原文件。

真实 edge 13 接受：控制网连续偏差界 `2.22e-16 mm`；原 openNURBS C3 PointAt 对拍误差
`2.52e-15 mm`，共享顶点→C3 偏差 `2.66e-15 mm`。含量化的平面、圆柱、共享边上界分别
为 `0.001173623 / 0.002767201 / 0.000173623 mm`，均小于总预算。

真实 edge 16 拒绝：当前网格点所需最大修正 `0.0001359970 mm`，大于声明
`0.0001293462 mm`；直接用原 openNURBS trim PointAt 做独立圆柱残差检查得到
`0.0001361483 mm`，确认不是投影算法误差。文件仍为 10/14 面部分预览。

受控测试仅把 edge 16 声明改为 `0.0002 mm`，原几何不变，验证容差修正分支：
189 点与正权凸包给出连续偏差界 `0.000162701 mm`，修复后两侧支撑残差小于 `8e-15 mm`；
含量化的平面/圆柱上界为 `0.001467564 / 0.005333373 mm`。
这一测试不是原文件的授权声明，不计为真实 edge 16 支持证据。
另以 `0.00014 mm` 验证“样点似乎通过、连续上界不足”仍拒绝。

## 验收与下一缺口

专项 3/3、既有 30/30、5 件 GLB 审计、真实孔洞、专项 tsc、repository gate 通过。
既有 V4 example_file 六面闭壳仍通过 8 顶点/18 边/12 三角、Euler=2、每边正反各一次；
不把部分 MechPartB 或单个圆柱当作完整闭壳。负例覆盖单位变化、紧预算、非法放大预算、
非单调对应、端点漂移、声明不足和连续证明不足。

本地证据 `test-output/industrial-3dm/source-edge-tolerance-2026-09-17-cae20e7/`：

- `source-edge-weld-evidence.json` SHA-256 `71f21b537263558ebdb7da8580df7a6fcacc30de0ba1e806b3481bc2080f0008`
- `source-edge-weld-control.json` SHA-256 `970a7c526610a2f60a5fe6870b71ef213dc358c021ef4e2aff3e8d47c9560b3d`

已检查 UntrimmedSurfaces、disk_brake、T-Joint 等固定官方样本；闭合多段 C3、其它面组合
仍明确不在本片范围。下一步是闭合/多段 C3 统一采样、真实非零声明容差正例、实例后误差
预算和完整混合曲面闭壳；V1 UUID 稳定性另片处理，生产 profile 与视觉验收不变。

## 证据路径纠正

早期测试共用 `test-output/3dm-source-audit/`，新切片回归覆盖了同名跨面证据。
`c4cc419` 规格中的 `360a9d82…` 是当时产物哈希，当前共享路径不能再用于校验该历史产物；
历史验证结论不改写。当前版本跨面复跑输出已隔离到
`test-output/industrial-3dm/cross-face-boundaries-2026-09-17-cae20e7/`，源边证据使用上列独立目录。
该版本 `boundary-evidence.json` SHA-256 为 `7fbde132ed8b29714b8e43d2a804c936ecbab649e6e43568d9c118cf76958460`。
复跑命令为 `pnpm exec tsx --test scripts/fixtures/3dm-source-edge-weld.test.mts scripts/fixtures/3dm-brep-boundary-audit.test.mts`。
历史源代码仍由 `c4cc419` 保留；今后每个改变产物的切片使用新目录，不覆盖已报告切片目录。
