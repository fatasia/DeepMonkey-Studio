# X_T 多壳实体遍历修复

原生研究转换现在完整遍历 REGION 和 SHELL 链，补回三个真实模型遗漏的 15 个面。109 件语料的报告面数均与独立原始 FACE 计数一致；生产 profile 仍未认证。

## 根因和实现

旧 `cad-xt::lower_body` 遍历 REGION 链，但只取各 REGION 的首个 SHELL；`lower_shell` 不跟随 SHELL 的 `next`，所以同一区域的第二个壳被漏掉。CLI 自己的总面数也来自这个不完整的降低结果，导致“已离散/总面数”相等仍不能发现丢面。

字段证据来自本地公开格式参考 `xt-reference.md` §5.3.5/5.3.6，以及 Gmsh 2.11 历史 `sch_9008.sch_txt`：REGION[3] 是 next、[5] 是 shell、[6] 是 `S`/`V`；SHELL[3] 是区域内 next、[4] 是 back-face、[7] 是 region、[8] 是 front-face。

新增 `shell_chains.rs`，独立处理链遍历与类型/归属检查：

- REGION 和 SHELL 均沿 next 遍历，预算不超过原始实体数；环、缺失实体、错类型、未知区域类型与跨 body/region 引用均返回显式诊断。
- 只收集 solid 区域的壳和无 REGION 的直接壳，按源 handle 去重、排序。Void 区域的 front-face 是边界的另一侧，不重复降低。
- 错误使该 body 的壳集合停止降低，并保留 `Skip` 原因；不静默截断链，也不生成替代几何。

## 验证

`cargo test -p cad-xt --lib --offline --locked` 13/13 通过。新增测试覆盖多节点链、空链、环、预算、缺失与错类型；通过真实解析入口构造 V9 BODY、solid/void REGION 和双 SHELL，验证去重、void 排除、未知类型与损坏链诊断。新模块格式检查通过。

| 样本 | 修复前源面缺口 | 修复后离散/原始面 | 三角形 |
| --- | --- | --- | --- |
| A-1230-60-22 | 2 | 217/217 | 17526 |
| AS-2520 | 3 | 37/37 | 3712 |
| AA-0220RB | 10 | 70/70 | 24700 |
| AA-0220LB（对照） | 0 | 62/62 | 27780 |

主线程全量证据 `test-output/xt-native-shell-fixed/evidence.json` 已复核：109 个 preview、0 个失败、109 个报告计数一致，0 个生产认证。证据 SHA-256 `1d0d38b91dcd1166642861cc89f62bc12ad63087444b94a6a72f4ae18cb9835e`。

## FaceId 与源身份

[xt-shell-source-audit.rs](../../scripts/fixtures/xt-shell-source-audit.rs) 对三个缺陷样本断言：原始 FACE 集合与 `face_sources` 集合相等、源 handle 唯一、每个 FaceId 归属于一个已降低壳、`face_sources.len()` 等于 `solid.faces.len()`。空输入直接失败。

- A-1230：body 7 的 FaceId 9/10 对应源 7826/7828。
- AS-2520：body 23 的 FaceId 15/16/17 对应源 215/205/208。
- AA-0220RB：body 24 的 FaceId 30..39 对应源 465、467、449、446、398、462、454、452、348、401。

该审核仍打印既有 null-edge FIN 的 `Skip`；A-1230 有 2 条，AA-0220RB 有 1 条，AS-2520 为 0 条。因此上述结果证明源面身份与归属覆盖，不证明全部边/环语义正确。`to_scene` 当前用 `face_sources` 查询面材质，尚未完整导出 X_T 面 handle 到发布产物；交付级 GLB source-map、孤立极点、几何精度和闭合性仍需独立验收。

## 工件

- [最小补丁](../../scripts/fixtures/cadconvert-xt-shell-chains.patch)，SHA-256 `ba0d9cd72e58adb6fd5c5d4d1cef6e32e6af681dde9077055caeec501448493f`。针对研究提交 `73b37836a55f905ea0f392cf676dff160c745287`，在既有 `cadconvert-xt-triangle-distance.patch` 后应用；反向 `git apply --reverse --check` 已通过。
- release CLI SHA-256 `44b687407c71a54ac1ac82a8e359278f49118f0ba02fd1725745b91f3fbef88d`，离线 locked 构建通过。
- 原始 CAD 与派生 GLB 仅保留本地忽略目录；补丁和审核程序不包含客户或制造商原始模型。
