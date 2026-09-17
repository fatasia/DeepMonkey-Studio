# X_T 逐面几何见证审计

这项审计把原始 X_T 面的几何见证与 GLB 对应 `faceRange` 内的三角形对拍，能发现同一个 BODY 内互换合法 FACE 标签、但集合审核仍通过的情况。

109 件真实语料共 19344 面：19151 面匹配当前见证，12 面存在几何差异，181 面缺少本审计可支持的见证。当前不能认证逐面几何完整。

## 独立性与比较方法

[原始见证导出器](../../scripts/fixtures/xt-face-geometry-oracle.rs) 只链接 `xt-parser` 和 JSON 序列化库，不链接 `cad-xt`、IR、降低或离散代码。它从原始 FACE→LOOP→FIN→VERTEX→POINT 取源边界/孤立点，并直接读取明确字段布局的平面、圆柱、球面参数。单位按 X_T 源米转为 mesh 局部毫米，与转换器缩放合同对齐。

[审计入口](../../scripts/audit-xt-face-geometry.mjs) 校验源文件/GLB 与已有转换证据的 SHA-256，读取真实 BIN、POSITION、indices 和 source-map 三角区间。每面执行两类检查：

- 源边界点到该面三角形集合的最近距离。允许顶点合并，也允许合法平面孤立点落在三角形内部，不要求保留完全相同的离散顶点列表。
- 每个输出顶点到原始解析曲面的方程残差；面法线方向、曲面内部弦差另属后续检查。

固定诊断容差为 `max(0.01 mm, 最大绝对坐标 × 2^-21)`；后项覆盖 Float32 坐标舍入。没有按本次差异放宽阈值。面级记录分别保留 source witness SHA-256、规范化三角位置 SHA-256、最大点距、最大曲面残差及见证重复数。两个 hash 的含义不同，不能直接比较是否相等。

最近距离先用离散顶点确定上界，再用三角形包围盒排除不可能改进的候选；完整 109 件对拍在本机约十余秒完成。

## 测试与差异

`node --test scripts/audit-xt-face-geometry.test.mjs`：7/7 通过，覆盖：

- 实际 GLB 内同 BODY 两个共面但分离的 faceRange 互换标签；原始 handle 集合仍相同，几何见证拒绝。
- 边界一致、内部顶点偏离平面；圆柱/球面半径互换；Float32 小扰动。
- 截断 GLB、越界索引、非法坐标、空几何；源点在三角形内部的合法情况。
- 完全重合几何作为显式盲区，不虚称唯一身份。

实测分类：

| 分类 | 面数 |
| --- | ---: |
| 当前见证匹配 | 19151 |
| 几何见证差异 | 12 |
| 无当前可支持见证 | 181 |
| 同 BODY 内源见证完全重复 | 206（与上述分类重叠） |

主要差异：

| 模型 / 源面 | 差异 |
| --- | --- |
| A-1811 / 1199，A-1821 / 226 | 源边界点到面三角形约 0.43 mm |
| AA-0220LB / 244、438 | 圆柱面顶点残差约 1.37、2.84 mm |
| AZ-0621,AZ-0622 / 674 | 圆柱面残差约 0.016 mm |
| AA-0222B / 5108、10980 | 圆柱面残差约 0.020 mm |
| AS, AT-2810L / 1263、1524 | 圆柱面残差约 0.023、0.138 mm |
| AS, AT-2810R / 82、360、1641 | 圆柱面残差约 0.023、0.044、0.138 mm |

这些是需要追踪的独立几何疑点，不把它们自动归因于标签互换，也不直接等同于已完成参考 CAD 真值校验。CLI 写出完整结果后，存在差异返回 2；仅存在未判定面返回 3。报告明确 `allFacesWitnessMatched=false`、`productionProfilesCertified=0`。

## 可证明范围和盲区

见证匹配证明这些源点在指定标签的三角形上、以及输出顶点满足支持的解析曲面方程。它不证明三角形精确填充整个原始裁剪域，也不证明同几何重合面的身份唯一性。206 个重复见证面已显式记录；相同支撑曲面、重叠边界或在当前容差内近似相同的面也可能互换后继续通过。

181 个未判定面包括没有可用边界顶点且曲面类型不在平面/圆柱/球面范围的面。尚未实现 NURBS/圆锥/圆环/偏置曲面语义检查、裁剪曲线连续覆盖、孔洞域、法线方向、面积/体积、节点实例变换和世界坐标审计。当前读取未量化 Float32 mesh；压缩、稀疏或量化 accessor 明确拒绝。

原始见证与产品共享文本 parser/schema，因此可独立检验 lowering、source-map 和离散阶段，但不能发现两侧共享的解析错误。该边界保持在证据范围中，未引入商业 SDK 或运行依赖。

## 复跑

先在已锁定的研究 native workspace 构建依赖，然后用其 release `xt_parser` 和 `serde_json` rlib 编译导出器：

```powershell
$deps = 'data/external-assets/format-research/cadconvert/native/target/release/deps'
$parser = (Get-ChildItem $deps -Filter 'libxt_parser-*.rlib' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
$json = (Get-ChildItem $deps -Filter 'libserde_json-*.rlib' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
rustc --edition=2024 -C lto=thin -C opt-level=3 scripts/fixtures/xt-face-geometry-oracle.rs -L "dependency=$deps" --extern "xt_parser=$parser" --extern "serde_json=$json" -o test-output/xt-face-geometry-oracle.exe
node scripts/audit-xt-face-geometry.mjs test-output/xt-face-geometry-oracle.exe test-output/xt-native-mapped/evidence.json data/external-assets/industrial-format-plan/samples/downloaded/x_t/asmith-hinges test-output/xt-face-geometry-evidence.json
```

输入转换证据绑定 CLI hash `27a0a19dbc89a6791c4ed2eb76acb307b6dbc37f5ecb0479c4911f002b6b26ac`；报告记录 oracle、原始见证和转换证据 hash。CAD、GLB 与完整逐面结果保留在本地忽略目录，不随代码提交。
