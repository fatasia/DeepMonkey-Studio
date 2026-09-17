# X_T 交线 chart 投影细分修复（2026-09-17）

## 结论

固定 `0.01 mm` 门槛下，逐面审计由 `19156 matched / 7 mismatch / 181 unresolved`
改善为 `19158 / 5 / 181`。AA-0220LB face 244 与 face 438 的圆柱面最大残差从
`0.056028 mm`、`0.056251 mm` 降至 `0.002928 mm`、`0.003044 mm`；109 个真实
X_T 文件继续全部生成预览证据，未新增 mismatch。

## 根因与修复

两面共享的 INTERSECTION edge 42 只有稀疏 chart。端到端曲面交线 walk 会在多分支
交线处走到另一支，原门禁又把候选点只与离散 chart 顶点比较；保留 chart 则会把弧写成
直线弦，边界点离圆柱约 `0.056 mm`。同时，零裂缝的 boundary rebuild 可以离开已知
解析曲面 `1.371 mm` / `2.841 mm`，仍因裂缝数较少胜出。

补丁 `scripts/fixtures/cadconvert-xt-projected-intersection.patch` 做两项通用修复：

- 解析曲面上的 rebuild（含 planar fallback）必须在当前 sag 内，不再用面尺度的 10% 放行。
- 端到端 walk 离开 chart 分支时，以 edge 范围内的 chart 弦作引导，将中点交替投影到两张
  定义曲面，并按投影 sag 自适应细分；每点位移受 chart 自身局部分辨率约束。分支距离改为
  点到连续折线段，不再误用点到离散采样顶点。

修复不依赖文件名、面号、坐标或商业组件，也没有改变 `0.01 mm` 审计门槛。

## 验证证据

- `cargo test -p cad-xt --release`：16 passed；新增“投影 chart 不跳到对侧分支”测试。
- `cargo test -p cad-tess --release`：37 passed。
- `cargo build --release -p cad-cli`：通过。
- `verify-xt-native-corpus.mts`：109/109 `previewEvidence`，0 failed，109/109 counts agree。
- `audit-xt-face-geometry.mjs`：19,344 faces；19,158 matched；5 mismatch；181 unresolved。
- 转换证据 SHA-256：`914f8ff8e0f33cd012670c92e36c1c92ba84906b7aefc4c2c718f20f799b712b`。
- 逐面审计 SHA-256：`cadec2b4a5476ff36310f91a7c02fbb476a7a7decb5cbd0e7bc4c3689c854883`。
- 被测二进制 SHA-256：`6ace97d01cc2fee9521026459eae521621c257cfbb5681ffb71ef2152bb645a2`。
- 补丁 SHA-256：`5239d2850d0954594ccf54263de8d014d07b41f4887f2553c40e906130c72055`；
  已通过 `git apply --reverse --check` 对当前本地源码反向校验。

## 仍剩问题

剩余 5 个 mismatch 未被本修复掩盖：AA-0222B 两个交线 chart 偏差；
AS/AT-2810L 与 AS/AT-2810R 的两个 SP_CURVE stand-in；AS/AT-2810R 的一个交线
chart 偏差。181 个 oracle unresolved 与 production profile `0` 保持未认证。
