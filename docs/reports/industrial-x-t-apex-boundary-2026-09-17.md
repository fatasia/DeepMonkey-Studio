# X_T 单顶点边界候选门禁修复（2026-09-17）

## 结论

X_T 面几何审计从 `19154 matched / 9 mismatch / 181 unresolved` 改善到
`19156 matched / 7 mismatch / 181 unresolved`。A-1811 face 1199 与 A-1821 face 226
的边界残差分别从约 `0.434 mm` 降到 `3.75e-7 mm` 与 `2.30e-7 mm`，均通过
固定 `0.01 mm` 门槛。109 个真实文件继续全部生成预览证据，无转换失败。

## 根因与修复

这两个圆锥面都声明了一个无半边的单顶点 bound。读取和参数域拼接已经正确保留
顶点；错误发生在面候选比较阶段：`file_rings` 只收集有边环，`boundary_gaps`
也只检查线段，所以丢失顶点的 boundary rebuild 仍被记作零缺口并胜过参数面路径。

补丁 `scripts/fixtures/cadconvert-xt-apex-boundary.patch` 将已声明的 apex 作为 singleton
ring 纳入原有候选门禁；singleton 的精确 `f32` 顶点不在候选 mesh 中即计一个缺口。
这是拓扑语义修复，不改变 `0.01 mm` 公差，不按文件名、面号或坐标特判。

## 验证证据

- `cargo test -p cad-tess --release`：37 passed，包含单顶点必须保留的聚焦测试。
- `cargo build --release -p cad-cli`：通过。
- `verify-xt-native-corpus.mts`：109/109 `previewEvidence`，0 failed，109/109 reported counts agree。
- `audit-xt-face-geometry.mjs`：19,344 faces；19,156 matched；7 mismatch；181 unresolved。
- 转换证据：`test-output/xt-native-apex-bound/evidence.json`，SHA-256
  `9d284afcb563e3f246de248f4aa35835710132ff74d04bd361d72b82f80da88f`。
- 几何审计：`test-output/xt-face-geometry-apex-bound.json`，SHA-256
  `20ce2f7ef490fe588c57c6ac2344ec15db91a7aed720bd12f6089c9a6ff64063`。
- 被测二进制 SHA-256：
  `d60e4427c4153b5ddc1510036b37f9309d39a855bd84575bd0818488a21d9db0`。

## 仍剩问题

剩余 7 个 mismatch 未被本修复掩盖：AA-0220LB 两个重建面曲面偏差、AA-0222B
两个交线 chart 偏差、AS/AT-2810L 与 AS/AT-2810R 的两个 SP_CURVE stand-in，以及
AS/AT-2810R 的一个交线 chart 偏差。另有 181 个 oracle unresolved，继续保持未认证。
