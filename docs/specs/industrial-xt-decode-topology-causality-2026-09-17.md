# X_T 字节解码与拓扑差异因果核对

本次只读检查当前研究代码，实验构建全部放在 `test-output/xt-causal-baseline`，未修改当前 parser、几何源码或 release 二进制。

## 非旧版样本为什么增加可转换面数

隔离副本来自 `cadconvert` 提交 `73b37836a55f905ea0f392cf676dff160c745287`。保持原版 `cad-xt` lowering 不变，分别输入原 `decode` 结果和逐字节字符映射结果；随后仅加入 V9 BODY 缺少 `nom_geom_state` 的 schema 修复，再跑同样两种输入，形成四组合。没有加入三角距离、NaN 或其他几何修复。

| 组合 | AS-2940 原始实体 / lowering 面 | AS(T)-AD5008 原始实体 / lowering 面 |
| --- | --- | --- |
| baseline | 1843 / 数值 panic | 1194 / 25 |
| decode only | 2567 / 75 | 1573 / 38 |
| schema only | 1843 / 数值 panic | 1194 / 25 |
| decode + schema | 2567 / 75 | 1573 / 38 |

两文件都是 V30，V9 schema 补丁不影响结果。原始 FACE 数量始终分别为 75 和 38，且索引全部唯一。增长的是成功解析引用图后能够降低为中立几何的面，并非新增 FACE。

原解码在 type 84 非 ASCII 属性后失去实体边界。FACE 记录虽已读到，但被其引用的拓扑和几何位于属性之后：

| 原解码未读到的后续实体 | AS-2940 | AS(T)-AD5008 |
| --- | --- | --- |
| LOOP | 56 | 19 |
| FIN | 232 | 45 |
| REGION | 1 | 1 |
| PLANE | 14 | 9 |
| CYLINDER | 7 | 2 |

AS-2940 原流在第 1843 个实体后错误识别 type 9，报告截断；AD5008 原流在第 1194 个实体后误识别结束记录，甚至返回 `truncated=None`。逐字节解码后，两个文件都到达真实的尾部 `1 0`，剩余输入为 0。`parse_entities_opt` 因此必须同时检查尾随输入，不能把 `Ok` 或空截断标记单独作为完成依据。

代码因果点：`xt-parser/src/lib.rs:66::decode` → `entity.rs:1084::read_raw_byte` 的长度计数 → `cad-xt/src/topo.rs:76::lower_body` 的引用图降低。原属性缺失改变后续引用可用性，最终影响面保留和几何数值。旧报告中的 AS-2940 `22/24` 尚未在本隔离对照中复现，不是原基线结果；本对照确证原基线 panic 到 decode-only 75 面，不把中间数字冒充原基线。

源 SHA-256：AS-2940 `c8d35b5c3d56ff4925251fdb23c6b99be861721cd191fcb39c0d4b3773f21089`；AS(T)-AD5008 `25ae99be82b7bc305a0d40466accfa44c596d0012e3dd82864af24403774ee46`。

## 26 个 null-edge fin 的性质

对当前 release parser 的 109 个文件读取 raw entities，再执行其 typed IR 构建：`missing-fin-edge=26`，其中非零且缺失的 edge 引用为 0。独立遍历原始 FIN 得到 26 个 `edge=0`，全部同时满足：

- `forward=backward=fin 自身索引`；
- `other=curve=edge=0`；
- `vertex` 指向存在且类型正确的 VERTEX。

这符合本地公开格式参考 `xt-reference.md` 第 3866 行定义的 isolated loop / isolated fin。应在审计中作为明确分类保留，不能简单取消所有缺边检查，也不能把非零缺引用归入此类。该结论仅证明这 26 个引用合法；cad-xt 对这种点状环的几何表达仍需独立检查。

审计夹具现已实现这一区分：先从 raw FIN/LOOP/FACE/VERTEX 关系构造严格证据，核对 LOOP 的首 fin 回指，再以 face node-id 和全局 vertex handle 绑定 typed fin；一个证据只能消费一次，typed loop 必须只有一个 fin、无 pcurve 且 vertex 存在。合法原始证据计入第四列 JSON 的 `isolatedFins`，不作为失败项；非零缺边、无证据的零边、错误自环和重复消费继续失败。shell 数量审计保持不变。

聚焦回归：legacy 6/6、v3 4/4 通过。使用已有 v3 release rlib 独立编译审计程序重跑 109 件：`isolatedFins=26`、`missing-fin-edge` 出现于 0 件；109 件仍保留 shell 数量差异并为 `incomplete`。报告在 `test-output/xt-causal-baseline/isolated-report.tsv`；此次未重建或改动 cad-cli。

## 另外三个真实缺面是 shell 链遗漏

当前 lowering 有三个原始 FACE 与导出面数不一致样本。逐条读取 SHELL/REGION/FACE 指针，证明遗漏的是同一实体区域的第二个 shell：

| 文件 | solid REGION | SHELL 链 | 漏面索引 |
| --- | --- | --- | --- |
| A-1230-60-22 | 7813 | 13 → 7811 | 7826、7828 |
| AS-2520 | 46 | 35 → 44 | 215、205、208 |
| AA-0220RB | 48 | 36 → 46 | 465、467、449、446、398、462、454、452、348、401 |

`cad-xt/src/topo.rs::lower_body` 只采集 REGION 的首个 shell；`lower_shell` 明确忽略字段 `[3]=next`。规范中该字段表示同一 region 的下一个 shell，因此遗漏不是合法的 void-region 筛选，也不是未知曲面拒绝。应遍历 shell 链、校验类型与循环，并保留 face 去重，随后重跑源实体与输出数量对拍。原始读取阶段没有缺面，缺陷位于中立拓扑构建。

实验入口为隔离副本 `native/crates/cad-xt/examples/causal.rs`；当前库对照可用 `rustc -C lto=thin -C embed-bitcode=yes` 链接既有 release rlib，输出单独研究程序。既有 release 文件保持不变。研究控制台计数与格式字段用于定位，不代替完整孔洞、方向、体积或渲染验收。
