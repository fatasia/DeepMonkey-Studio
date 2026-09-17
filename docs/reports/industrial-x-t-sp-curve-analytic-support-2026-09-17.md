# X_T SP_CURVE 解析支撑优选与弦差修复（2026-09-17）

## 结果

AS, AT-2810L face 1524 与 AS, AT-2810R face 1641 已在固定 `0.01 mm` 门槛内闭合。109 件本地离线样本全部生成 preview evidence；逐面审计从 `19160 matched / 3 mismatch / 181 unresolved` 收敛到 `19162 matched / 1 mismatch / 181 unresolved`，没有新增 mismatch。

本次只读取源文件已有的 FIN pcurve 与 SP_CURVE，不投影、猜测或制造边几何，不依赖商业 SDK、外部转换器、云服务或在线授权。

## 根因

两项失败来自左右件上同构的 tolerant edge。每条 edge 没有独立 3D curve，但相邻两个 FIN 都给出了同一条边的源 pcurve：

- 先被遍历到的 pcurve 位于 type 124 样条支撑面上；旧逻辑只要它能求值就立即选用，得到 `0.1378995773 mm` 圆柱残差。
- 另一个 FIN 明确给出位于源圆柱面上的 SP_CURVE，但旧逻辑没有继续读取它。
- 切换到源圆柱 pcurve 后残差降至 `0.0183424066 mm`；剩余量来自 SP_CURVE sampler 写死的 `0.2 mm` 弦差上限，而不是解析或曲面求值失败。

这两条边的引用链分别为 edge 1558 → pcurve 1564/1584 与 edge 1675 → pcurve 1681/1701。解析圆柱 pcurve 是源文件对同一拓扑边的另一份精确参数描述，不是事后投影。

## 修复

- 收集 tolerant edge 的全部 FIN pcurve 后，稳定优先选择位于平面、圆柱、圆锥、球面或圆环面上的源 SP_CURVE；相同支撑类别仍保持源 FIN 顺序。
- SP_CURVE 仍按其参数 NURBS 和支撑面求值，只把自适应弦差从 `0.2 mm` 收紧到固定门槛一半的 `0.005 mm`。
- 新增聚焦单测，锁定解析 FIN pcurve 对样条 stand-in 的优先级。

补丁：`scripts/fixtures/cadconvert-xt-sp-curve-analytic-support.patch`。补丁已通过 `git apply --reverse --check`，SHA-256 为 `38ffc43b7a03c7f66ce4e4ee0995298909145568bec5cba8eb0a73444d482abb`。

## 验证

- `cargo test -p cad-xt --release`：18 passed。
- `cargo test -p cad-tess --release`：37 passed。
- `cargo build --release -p cad-cli`：通过。
- 聚焦真实边检查：face 1524、1641 的最坏边残差均为 `0.0043758500 mm`；此前已修的 AA-0222B 两面继续通过。
- 109 件转换：`109 preview-evidence / 0 failed / 109 reportedCountsAgree / 0 production profiles certified`。
- 转换证据：`test-output/xt-native-sp-analytic/evidence.json`，SHA-256 `e8809225e0dd9f38f33f12d797d7e28d2ea9678ef8dd78a2847a22174bd74442`；被测二进制 SHA-256 `15d451101bb78c61ee8518d10ba8dac29d7f916e06e0c4a570eb82940083d307`。
- 逐面审计：`test-output/xt-face-geometry-sp-analytic.json`，SHA-256 `896e0736b60d604a57eaeb0f4205ed5e7e4bc854538893cd1b7b46647b64be6f`。

| 样本 / face | status | surface max | boundary max | vertices |
|---|---|---:|---:|---:|
| AS, AT-2810L / 1524 | witness-match | `0.0043758473 mm` | `0.0000000589 mm` | 514 |
| AS, AT-2810R / 1641 | witness-match | `0.0043758473 mm` | `0.0000000589 mm` | 514 |

## 剩余 mismatch

只剩 AS, AT-2810R face 360：圆柱面内部最大偏差 `0.0441604055 mm`，边界最大偏差 `0.0000006589 mm`。它来自另一类 INTERSECTION chart 早退，不与本轮 SP_CURVE 修复混改。`181 unresolved` 与 production profile `0` 保持未认证。
