# X_T 最后一个交线差异：源支撑域诊断

AS, AT-2810R face 360 继续保持 mismatch，误差预算仍为 `0.01 mm`。本片新增可复跑诊断，没有变更转换算法或提升质量档。上一份已认证的研究语料结果仍是 `19162 matched / 1 mismatch / 181 unresolved`，生产 profile 为 0。

## 已证实的几何事实

源链为 edge 665 → TRIMMED_CURVE 675 → INTERSECTION 677，定义曲面为 CYLINDER 203 和 B_SURFACE 36 → NURBS_SURF 205，辅助数据为 SURFACE_DATA 206。两个 FIN 的 pcurve 指针都是 0，无法复用上一片的解析 FIN pcurve 修复。

205 是非有理 `2×8` 控制网格、`1×3` 次数的曲面，参数域 `[0,1]²`。全部控制点的 x 最大值为 `−0.0183 m`，z 最小值为 `−0.01222571065718376 m`。由于非负 B-spline 基函数的凸包性质，在该有限域内的曲面也受此包围范围约束。

675 的第二个源修剪端点是 `(-0.0179859358504677, 0.0053890873009434, -0.01289999999311994) m`。仅 z 方向就比控制网格范围超出 `0.6742893359 mm`，因此当前有限曲面不可能包含该端点。这是源端点与控制网格的直接比较，不依赖离散器自报残差。

现有反求及 441 个参数起点的局部反求都落在 `(u=1,v=0)` 附近；该端点距离为 `1.1419487397 mm`。扩大迭代次数或加密原 chart 不能消除这项有限域不相容。

## 排除的错误修复方向

- 已有未提交研究补丁把普通交线的段长早退改为双曲面残差检查；真实 675 随后仍被分支约束拒绝。不能把这个 guard 改动单独算作修复。
- 本片试验了双法线 Newton 校正，未解决有限域外端点；实验修改已撤回，研究二进制已从恢复后的代码重新构建。
- 诊断程序另作端部多项式延拓负对照：第二源端点仍残差 `0.0588241676 mm`，参数约 `(1.0188945,−0.4719038)`。该结果不进入转换器，不是有效源曲面。

Siemens 的格式参考规定，隐式延拓须由 SURFACE_DATA 的 extended intervals 表达，边界 `B` 表示有界；206 的 original/extended intervals 均为 `[0,1]²`，四边均为 `B`。当前没有依据任意扩展参数域。[格式参考，印刷页 70–72](https://ww3.cad.de/foren/ubb/uploads/Rainer%2BSchulze/XT_Format_April_2008_tcm73-62642.pdf)

这不等于判定整个源文件损坏。仍需核对旧版本几何引用、依赖的 geometric owner、可能遗漏的映射/替代支撑字段，以及同文件其他交线的共同模式。不能把该面转成 unresolved 来减少 mismatch。

## 复跑与证据

新增 `scripts/fixtures/xt-intersection-source-probe.rs`。它链接研究 `cad-xt/cad-ir/xt-parser`，用于支撑曲面和求值诊断；不是独立几何 oracle。源字段另由现有只链接 xt-parser 的 `xt-polyline-source-probe` 导出。

```powershell
# 按现有 oracle 构建方式链接 release deps，增加 cad_xt / cad_ir rlib。
xt-intersection-source-probe.exe '<本地 AS, AT-2810R.x_t>' 677 675
xt-polyline-source-probe.exe '<本地 AS, AT-2810R.x_t>' 36 205 206 675 677
```

本地独立证据目录：`test-output/xt-intersection-domain-20260917/`，原 CAD 和完整参数值不入库。

| 工件 | SHA-256 |
|---|---|
| 源模型 | `5d3a7a27d8a37b553b733d0e28c9e6affba94bbed7f5295521c74f4eadcb4e7d` |
| 原始记录 raw-records.jsonl | `bd46f217e9aa962ba915fe73e131b1dd5914b71802842951759abc367d031c2a` |
| 诊断输出 xt-intersection-domain-evidence.txt | `1787a2919bef2882949ef92325056ce83ce8ab7c9fbb90c5d995d0ef59410516` |
| 诊断程序 | `031e5b1555f20ed55432f5b47511fefc83324e1e0c154e51682e46a950e41573` |

实际运行通过；新增负对照单测 1/1、rustfmt、repository gate 通过。转换算法没有新修复，未重复声称 109 件全量转换验收。
