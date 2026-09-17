# X_T 固定毫米离散预算复核

109 件全部重转并完成强化源见证审核：**19332 matched / 6 mismatch / 6 unresolved**，共 19344 个面。生产 profile 仍为 0。此前强化见证下的 252 个差异缩减到 6 个，旧窄见证的“1 mismatch”不代表当前审核范围。

## 参数与单位

研究 runner 显式传入 `--quality plain --sag 0.005`，并把 `unit: mm`、`absoluteSag: 0.005` 写入证据。源 X_T 米坐标由 cad-xt 转为场景毫米；CLI 的 `--sag` 关闭相对 deflection，使用绝对毫米。源见证预算保持 `0.01 mm`，没有修改审核阈值。半预算用于离散，并不保证修剪、交线和曲面桥自动合格。

转换器本次 SHA-256 与上一轮不同；当前研究工作树含此前交线支撑检查改动。因此这次证明的是固定参数下的完整实际结果，不把全部变化或耗时归因于一个参数。

## 剩余差异

| 模型 | body / face | 源见证最大差异（mm） | 下一检查点 |
|---|---|---:|---|
| AS-0820 | 12 / 10596 | 边界 0.0244296350 | 圆环面闭圆修剪 |
| AS-0820 | 12 / 10619 | 边界 0.0274819414 | 圆环面闭圆修剪 |
| AS-0820 | 12 / 10672 | 边界 0.0488295413 | 圆环面闭圆修剪 |
| AS, AT-2810L | 22 / 1259 | 边界 0.0176360728 | 圆柱闭圆离散/接缝 |
| AS, AT-2810R | 34 / 78 | 边界 0.0176360728 | 同构圆柱闭圆 |
| AS, AT-2810R | 24 / 360 | 曲面 0.0441604055 | INTERSECTION 支撑/映射 |

前三项与旧输出的边界差异相同，单纯收紧 sag 未消除；最后一项源域诊断见 [交线报告](industrial-x-t-intersection-support-domain-2026-09-17.md)，有限域不相容不能直接推断整个源文件损坏。

6 个 unresolved 为 A,AS-1310L 的 2957/2962、A,AS-1310R 的 3826/3824，以及 AA-0222B 的 1809/1807；缺少当前 oracle 支持的源见证，不能计为匹配。

## 验证与复现

109/109 为 preview-evidence，109 件转换计数与实际 GLB 相符，0 件转换失败。输出总计 2043167 个三角形、74722700 字节；上一轮为 1582444 个三角形、63730876 字节。精度提升有网格和体积成本。跨二进制、跨运行环境不声明性能提升。

闭圆数学单测 2/2、审核单测 9/9、repository gate 和 diff-check 通过。完整几何审核因 6 个 mismatch 按约定非零退出。私有源模型、GLB 与本地证据不入库。

```powershell
pnpm exec tsx scripts/verify-xt-native-corpus.mts data/external-assets/format-research/cadconvert/native/target/release/cadconvert.exe data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges-inventory.json test-output/xt-native-absolute-sag-20260917
node scripts/audit-xt-face-geometry.mjs test-output/xt-face-geometry-oracle-circle.exe test-output/xt-native-absolute-sag-20260917/evidence.json data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges test-output/xt-face-geometry-absolute-sag-20260917.json
```

| 工件 | SHA-256 |
|---|---|
| 转换器 | `7be76ea89eb003f3725bb48716844f76d64b2f372d681ef240694342e037d646` |
| 转换 evidence.json | `0a136e3d3a9de350ce9dad9c7497970388b69a3cd17dd089ffb6d8994a812910` |
| 独立闭圆 oracle | `c8869e3e362a5b8f893f16f993029c0e20202c06a87f1bdc1f54a8dba7288741` |
| 强化审核结果 | `ed3c096a35c95ab9b9afc7a54e9cf8583863763ea06268e91597271f20ea3152` |
