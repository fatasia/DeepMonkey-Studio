# X_T 孤立顶点环降低

109 件真实语料中的 26 个孤立顶点环已保留为 IR 点状边界，原始面身份与顶点坐标逐项一致，降低阶段 `skipped` 总数为 0。

## 规范与表达

本地公开格式参考 `xt-reference.md` §4.3.7、§5.3.8.1 说明：孤立环只有一个顶点，文件通过单个 FIN 引用；forward/backward 均指向自身，other/curve/edge 均为空，sense 无意义。

现有 `cad_ir::Bound` 已支持 `vertex: Some(VertexId)` 与空 `halves`，`cad-tess` 已将其作为源文件明确给出的极点/锥顶边界。新增 `isolated_loop.rs` 验证规范形状、LOOP 归属、VERTEX 与 POINT 类型、真实有限坐标，再由 `lower_loop` 复用 `intern_vertex` 构造该 Bound；没有更改 IR、创建退化边或补默认几何。

非自环 FIN、多 FIN 的 null-edge 环、缺顶点、错类型、缺 POINT 和非有限坐标仍明确失败。普通有边 FIN 保持既有降低路径。

## 验证

- `cargo test -p cad-xt --lib --offline --locked`：15/15 通过。新增 V9/V21 两种 FIN 布局、源坐标准确保留、错误 LOOP、混合/重复 FIN、非法反向指针、缺失/错类型顶点与 POINT，以及普通有边 FIN 回归。
- [审核程序](../../scripts/fixtures/xt-isolated-loop-audit.rs) 遍历真实语料，独立从原始 FIN→LOOP/VERTEX→POINT 提取 `(源面 ID, XYZ IEEE-754 bits)` 多重集，与降低后的 `Bound.vertex` 多重集逐文件比较，并断言没有伪造半边。结果为 `files/source-point-loops/lowered-point-bounds/skipped=[109, 26, 26, 0]`。
- 空参数调用审核程序失败，不允许零样本通过；新模块格式检查与补丁反向检查通过。
- 两个真实样本完成 CLI 与产品 `auditGlbGeometry` 复测：A-1230 为 217/217 面、17526 三角形；AA-0220RB 为 70/70 面、12980 三角形。后者由 shell 修复阶段的 24700 三角形改变为 12980，说明源极点实际参与了离散决策。该数量变化本身不作为曲面精度改善的证明。

此处的零 `skipped` 是降低阶段统计，不等于已完成曲面误差、闭合性、拓扑工程验证或最终 GLB 源映射认证。26 个点状边界已真实进入离散器输入，后续最终产物仍走独立审计。

## 工件与复现

[最小补丁](../../scripts/fixtures/cadconvert-xt-isolated-loop.patch)，SHA-256 `bd07e99f7421afca9cc09bd96d6efe4c16df7f7f3e414538828fe85c77293cb4`，按顺序接在数值距离和 shell 链补丁后应用于研究提交 `73b37836a55f905ea0f392cf676dff160c745287`。原始 CAD 继续留在忽略目录，仅提交代码补丁和独立审核程序。

`cargo build -p cad-cli --release --offline --locked` 成功。该阶段 CLI SHA-256：`ccfa51d964731bdd669ee6e5e7d75097cf5def28ae53d33789097b5814595146`。

审核程序链接同一 release `cad_xt` / `xt_parser` rlib，以 `rustc --edition=2024 -C lto=thin -C opt-level=3` 编译，并传入本地 `asmith-hinges` 语料目录运行。LTO 参数与依赖构建保持一致，避免将 LLVM bitcode 当原生目标文件链接。
