# X_T 原生离散数值崩溃修复

本报告记录数值修复单独验证时的中间结果：AS-2940 从进程崩溃推进到 22/24 面预览。随后合并实体流修复的全量复跑已得到 75/75 面，见 [最新全量报告](industrial-format-plan01-02-lock-2026-09-16.md#6-2026-09-17-修复后全语料复跑)。没有开放生产 profile。

## 根因与修改

Debug 构建与 `RUST_BACKTRACE=1` 定位到 `cad-xt/src/topo.rs::distance_to_triangle`。Coons 候选网格出现长达约 `8.26e9` 的狭长三角形；`a*c-b*b` 消减为零后被设为 `1e-300`，重心参数溢出为负无穷，后续无穷相减产生 NaN，最终在 `clamp(0, NaN)` 崩溃。

- 点到三角形距离改为尺度归一化后的叉积投影，投影不在面内时取三条边的真实最近距离。共线/重合三角形保留其线段/点距离；非有限输入返回拒绝距离。不设置替代几何、任意行列式阈值或默认坐标。
- 同一次真实样本复测又触发 `cad-tess/src/face.rs::lay_each_facet_once` 整数溢出：过大坐标转 `i64` 饱和后再搜索相邻 bin。现于修改面之前验证索引可表示范围，无法表示时返回明确面错误。
- 新距离实现独立为 `triangle_distance.rs`，原有超大拓扑文件减少 16 行。

## 可复现补丁

研究来源：`omerbasavul/cadmesh` 本地镜像，提交 `73b37836a55f905ea0f392cf676dff160c745287`。根 `LICENSE` 为 MIT，版权所有者 `Copyright (c) 2026 omerbasavul`；native workspace manifest 标记 Apache-2.0。补丁保留局部上下文，生产分发仍需完成逐文件授权归档；本次未引入产品运行依赖。

补丁：[cadconvert-xt-triangle-distance.patch](../../scripts/fixtures/cadconvert-xt-triangle-distance.patch)，SHA-256 `2355816d2414848078e2f64da0889a66c48727b23db0c10ddc57421f0ed4b4ad`。从该研究仓库根目录执行 `git apply <补丁绝对路径>`；已在修改后的研究副本执行 `git apply --reverse --check` 验证补丁对应关系。补丁仅修改 `cad-xt` 和 `cad-tess`，不包括并行解析器研究改动。

在 `native/` 执行：

```text
cargo test -p cad-xt --lib --offline --locked
cargo test -p cad-tess --lib --offline --locked
cargo build -p cad-cli --release --offline --locked
```

实测通过：`cad-xt` 9/9，`cad-tess` 34/34；包含新增的面内/三边/三顶点距离、绕序反转、退化、非有限值、狭长三角形、跨尺度、越界面拒绝且不修改、重复面去重回归。Debug 与 release 样本转换均无 panic，GLB 内容 hash 相同。

## 真实样本与产品审计

原始 CAD 仅位于本地忽略目录，不提交。Asmith 公开铰链下载包中的 `AS-2940.x_t`，SHA-256 `c8d35b5c3d56ff4925251fdb23c6b99be861721cd191fcb39c0d4b3773f21089`。

使用 `scripts/verify-xt-native-corpus.mts` 调用修复后的 release CLI 并走产品 `auditGlbGeometry`，本地证据 `test-output/xt-as2940-fixed-audit/evidence.json`：

| 项目 | 实测 |
| --- | --- |
| release 二进制 SHA-256 | `91b5d35be23aff4d13dba4b52cf6c3bc247ae826032428cdf070bd6667ee7bfd` |
| GLB SHA-256 | `9a2e05543761cb36679373ac58853dc8c480ba0399d94ee3bede06b2064079ad` |
| 网格/顶点/三角形 | 1 / 4159 / 4608 |
| 面完成数 | 22 / 24 |
| face 7 | `face coordinates exceed finite facet-index range` |
| face 10 | `face declares 1 boundary edges but none of them could be built` |
| countsAgree / 已认证 profile | false / 0 |

该切片修复数值崩溃并保留明确丢面诊断。异常 Coons 几何的生成原因、缺失边、完整拓扑、源映射和几何精度仍待修复与验证；有限顶点和有效 GLB 不能证明源几何完整。

## 旧 BODY 降低层复核

并行解析器修复 `SCH_9008` 的 22 字段 BODY 后，复核发现 `cad-xt::lower_body` 已遍历 BODY 字段并按目标实体类型收集 SHELL/REGION，无需再添加固定字段分支。用当前 debug 构建实测 `A-1811.x_t` 得到 3 bodies、65/65 faces、8180 triangles，CLI 无 warning。这证明该样本可进入现有降低层，不扩大为旧版本的完整几何认证。
