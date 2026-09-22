# 3DM：真实圆柱与三次近似圆的双侧共边证明

本片记录 MechPartA edge 93 的双侧连续边界距离证书基线；后续已完成[证书驱动的共边重建](industrial-3dm-paired-reconstruction-2026-09-18.md)。下文未焊接计数对应显式关闭重建阶段的基线，不是最新默认导出结果。

## 根因

face 40 的平面 trim 与 C3 是非有理三次近似圆，原控制网身份证明通过。face 39 使用有理二次圆柱截线，其 C2 是 5 点分段直线。二者不是同一精确曲线，增加采样数或把单侧 C3 身份通过当作跨面通过都会产生错误结论。

新增 `3dm-paired-boundary-proof.mts`，复用齐次 Bézier 子区间、次数提升与正权控制凸包误差界。对原 C3 到圆柱等参线提出单调分段参数对应，每个对应区间独立验证连续界；最近点搜索只提出区间，不能充当证明。验证覆盖正权、C0 knot、端点、trim 单调性、单位、分段预算和源容差。源声明容差及物理预算均仍为 **0.01 mm**。

证书通过 `completeBrepParts` 写入 GLB sidecar 的 `sourceBoundaryPairProofs`。它不修改共边的 `conforming`，不修改源 IR、网格顶点、法向或三角，不增加 `ready` 放行。

## 实测

固定 openNURBS v8.35.26251.13001 官方 `V4/v4_MechPartA.3dm`，源 SHA-256 `a1b0ef69925b5d9223a7d797033055bb766842768a96f7713e1ecaec2763bb31`，毫米，仅本地验证、不再分发。

- edge 93 两面为 40/39；296 个参数区间，双侧连续界 **0.0004992576707879414 mm**。
- 114 个原生 C2/C3 PointAt 参考与每个区间 33 个映射点独立核验；证书双次生成逐值一致。
- 真实完整 GLB 仍为 41 primitives、48,067 顶点、85,632 三角；SHA-256 与本片前逐字节相同：`82a84b95a08661260f3e2a42965b58698d70868245abe9a27efe6edb9a006523`。
- 49 条非共形边不变、7 条自缝仍通过，edge 93 明确为 `continuous-source-pair-certified-mesh-not-welded`。
- 新增 3 项实样/失败边界测试及 21 项相邻回归通过；专项 TypeScript 检查通过。没有重跑无变化的 Wheel 大网格或新编译原生解析器。

证据：`test-output/industrial-3dm/paired-boundary-2026-09-18/pair-proof.json`、`evidence.json`、`MechPartA.glb`。

复跑：`pnpm exec tsx --test scripts/fixtures/3dm-paired-boundary-proof.test.mts`。

下一步可在该证书下研究圆柱边界按源 C3 重建，必须把偏离原曲面、三角细分、Float32 与既有误差相加后仍满足预算，并保持相邻已通过共边；不能直接按空间距离吸附。本片只增加连续源关系证据，不计跨面缝合或产品视觉验收完成。
