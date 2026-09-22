# X_T 实际相邻支撑恢复

AS, AT-2810R 的最后一个已知几何差异已修复；109 件真实样本的 19,344 个源面均通过既有独立 witness 检查。范围仍为 builtin-only 本地研究 preview。

## 根因与修复

EDGE665 的 INTERSECTION677 指向 CYLINDER203 和旧 B_SURFACE36；后者仅有 2×8 控制网、有限参数域，第二个修剪端点距离它约 1.142 mm。

沿原文件 FIN354/330 → LOOP502/355 → FACE440/360 可找到真正相邻的 B_SURFACE376 和 CYLINDER431。前者已经由源文件扩展为 3×11 控制网，域为 u=[0,1.13274469805805]、v=[-0.636822437507701,1]；同一个端点在该面上的残差为 1.07e-17 m。无需自行外推曲面。

新增 `adjacent_intersection::recover` 只在原始端点确实离开旧支撑时尝试恢复：验证双向 FIN、共同 EDGE、不同 FACE、同一 SHELL；两个原始端点必须同时位于两个实际面内。复用既有求交折线算法，保留原 chart 分支范围，逐段检查两面残差和弦内点。生成的单一 EDGE 曲线由两个相邻面共用，不单侧吸附。失败时保留旧路径。

预算继续使用 min(edge tolerance, solid tolerance)，本件为 0.00001 m，即 0.01 mm。弦内检查是数值采样，不是连续全域误差证明。

## 实测

| 指标 | 修复前 | 修复后 |
|---|---:|---:|
| 109 件转换成功 | 109 | 109 |
| 源面 witness 匹配 | 19,343 | 19,344 |
| mismatch / unresolved | 1 / 0 | 0 / 0 |
| FACE360 圆柱残差 mm | 0.0441604055 | 0.0006396840 |
| 本件面数 | 51 | 51 |
| 本件顶点 / 三角形 | 14,446 / 23,695 | 14,447 / 23,689 |
| 全语料 Float32 零面积三角形 | 79 | 79 |

三角形数量变化来自共享曲线重新离散及相邻面重三角化，没有删除退化三角形的后处理。仅本件 BODY24 的 FACE430/440/360 三个面的三角指纹改变；其余面不变。所有源文件、body/face 身份、逐面 witness SHA 和原始 oracle 输出 SHA 均与旧基线相同。

79 个既有零面积三角形、12 个重复 witness 面仍然存在；本片不等于水密拓扑、任意曲面内域或完整生产格式认证。

## 文件与验证

- 原生实现：`data/external-assets/format-research/cadconvert/native/crates/cad-xt/src/adjacent_intersection.rs`，接入 `lib.rs`、`topo.rs`。
- 可入库独立补丁：`scripts/fixtures/cadconvert-xt-adjacent-intersection.patch`；在既有 native 基线上 `git apply --reverse --check` 通过，可应用性不依赖其他团队改动的整包 diff。
- 定向测试：`scripts/fixtures/xt-adjacent-intersection.test.rs`，真实源件、1,025 个双侧采样、错误端点、错误实体、断开的 FIN、旧有限支撑、闭合歧义和无效预算；1/1 测试通过。测试要求 `XT_ADJACENT_SOURCE` 指向固定源件，不静默跳过缺失样本。
- 诊断：`scripts/fixtures/xt-intersection-source-probe.rs` 新增可选实际第二支撑参数；只用于诊断，不替换 oracle。
- `cargo build -p cad-cli --release --offline` 通过；实际 CLI package 是 `cad-cli`，`cad-convert` 是库。
- 109 件转换：`test-output/xt-adjacent-support-20260918/evidence.json`。
- 独立几何检查：`test-output/xt-adjacent-support-20260918/face-geometry.json`，仍用未修改的 `xt-face-geometry-oracle-spline.exe`。

源件：`asmith-hinges/A  Hinges (鉸鏈)/Removable Concealed Hinges隱藏可拆鉸鍊/AS, AT-2810R/AS, AT-2810R.x_t`，SHA-256 `5d3a7a27d8a37b553b733d0e28c9e6affba94bbed7f5295521c74f4eadcb4e7d`。沿用原固定语料清单及使用边界，不新增样本分发。

| 产物 | SHA-256 |
|---|---|
| cadconvert.exe | `432264f36a477b32bb8d825cd633e8900854add10be1309e2bd9f6200d743483` |
| evidence.json | `09862b8d8df880aa63ed31281c80e866927189d320aa8f8177857f0e12fa3473` |
| face-geometry.json | `baf0aa284b4b8e3381ea697e38ca9aa71d659d27af191ed2a58f016d69560a84` |

旧基线为 `xt-native-periodic-reseam-final-20260917/evidence.json` + `xt-face-geometry-closed-spline-20260917.json`，不是更早的 5 mismatch / 181 unresolved。
