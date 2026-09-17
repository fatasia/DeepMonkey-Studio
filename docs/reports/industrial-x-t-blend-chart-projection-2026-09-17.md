# X_T blend chart 单曲面投影修复（2026-09-17）

## 结果

AA-0222B 的两个圆柱面偏差已在固定 `0.01 mm` 门槛内闭合。109 件本地离线样本仍全部生成 preview evidence，逐面审计从 `19158 matched / 5 mismatch / 181 unresolved` 收敛到 `19160 matched / 3 mismatch / 181 unresolved`，没有新增 mismatch。

本次只修复 blend 交线 chart 的通用几何路径，不修改格式门槛、不按样本或实体编号分支，也不引入商业 SDK、转换器、云服务或在线授权依赖。

## 根因

四条失败边都是 `INTERSECTION`：一侧是 blend surface，另一侧是可直接求值的圆柱面。原实现发现 chart 已到达边端点后，会为避免昂贵且不稳定的 blend surface 构造而直接保留原 chart。AA-0222B 的这些 chart 只有 6 个折线点，端点正确但弦到圆柱面的最大偏差约 `0.0196475 mm`，因此两个重建圆柱面均超过 `0.01 mm`。

同一组实体里有两条 curve 的参数方向与 edge 方向相反。直接把 edge 端点钉到未定向 chart 会得到错误引导线，这解释了首轮只修复四条边中两条边的现象。

## 修复

- 当交线含 blend surface、chart 已到达端点且另一侧 surface 可求值时，仅把 chart 投影到这张已知 surface；不构造 blend surface。
- 递归投影每段中点，以 `tolerance * 0.5` 控制投影曲线弦高，再用原 chart 的声明/采样 slack 约束候选曲线不得跳到其他分支。
- 投影前比较 chart 两端与 edge 两端的正向、反向配对距离，必要时反转 guide，再钉住端点。
- 两张 surface 都可求值的原交线投影路径复用同一套定向 guide。

补丁：`scripts/fixtures/cadconvert-xt-blend-chart-projection.patch`。该补丁已通过 `git apply --reverse --check`，SHA-256 为 `4aa973ae962264fe57a4d67018e6fb24922318d1b4d9ea65656afc6983177f08`。

## 验证

- `cargo test -p cad-xt --release`：17 passed。
- `cargo test -p cad-tess --release`：37 passed。
- `cargo build --release -p cad-cli`：通过。
- 109 件转换：`109 preview-evidence / 0 failed / 109 reportedCountsAgree / 0 production profiles certified`。
- 转换证据：`test-output/xt-native-blend-chart-project/evidence.json`，SHA-256 `b5b9b5634d5699d36dd09f5d9b385f7f2279240ee28bebc3a57a8c0bee10ef1e`；文件记录被测二进制 SHA-256 `10494e0f5eb99a8f09278911ae2b3257e6f12731237b54f6257826a1c513a501`。
- 逐面审计：`test-output/xt-face-geometry-blend-chart-project.json`，SHA-256 `4f7394cbff28cb28c03454b8c382308f9c0a679abf4f72d59a7acff953d5e605`。

AA-0222B 精确结果：

| face | status | surface max | boundary max | vertices |
|---:|---|---:|---:|---:|
| 5108 | witness-match | `0.0045937840 mm` | `0.0000014307 mm` | 105 |
| 10980 | witness-match | `0.0045937840 mm` | `0.0000007629 mm` | 105 |

## 剩余 mismatch

剩余 3 项均在 AS, AT-2810L/R，边界已经匹配，偏差来自圆柱面内部：

| 样本 | face | surface max | boundary max |
|---|---:|---:|---:|
| AS, AT-2810L | 1524 | `0.1378995778 mm` | `0.0000000589 mm` |
| AS, AT-2810R | 360 | `0.0441604055 mm` | `0.0000006589 mm` |
| AS, AT-2810R | 1641 | `0.1378995778 mm` | `0.0000000589 mm` |

`181 unresolved` 与此前一致；本轮没有把 unresolved 当作通过。生产 profile 仍为 0。
