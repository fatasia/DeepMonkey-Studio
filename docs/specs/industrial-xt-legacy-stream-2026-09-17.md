# X_T 旧版实体流修复

2026-09-17：Asmith 109 个真实样本全部读到显式结束记录，剩余输入为 0，解析截断标记为空。此前 31 个 `SCH_901000_9008` 样本在首个 BODY 后错位。此结果只证明实体流读取，几何、装配、属性显示和生产认证另行验收。

## 两个根因

- `SCH_9008` 的 BODY 不包含后来的 `nom_geom_state` 字节。现有 V13 布局多读一个字段，吞掉后续 TRANSFORM 的类型号 `100`，将其索引 `4` 当成 PMARK，最终报告误导性的 EOF。旧布局有 22 个字段，shell 位于 15、region 位于 19；研究 parser 和 typed-body 映射均已修复。
- 属性字符串按源字节计数，非 ASCII 内容不局限于文件头。UTF-8 有损解码可合并多个源字节，导致读取属性时吃掉下一条实体记录。`decode` 对 ASCII 保持零复制，对其他输入逐字节映射为字符；显示层仍需根据源代码页解码标签，不可把映射字符当成正确的中文显示结果。

同时补齐实体流结束诊断：缺少终止记录、非法类型 token、终止记录后仍有数据均设置 `truncated`；不完整终止记录返回错误。调用方必须检查截断状态和剩余输入，不能仅检查 `Ok`。

## 来源和可复现工件

- 本地开源研究基线：`cadconvert` 提交 `73b37836a55f905ea0f392cf676dff160c745287`，其 `native/crates/xt-parser` 为 Apache-2.0 研究实现，尚未作为产品依赖安装。
- 修复与四项聚焦测试、全语料流审计示例收录于 `scripts/fixtures/xt-parser-legacy-stream.patch`。从仓库根目录对上述基线执行 `git apply <绝对补丁路径>`；补丁反向检查已通过，未包含本地模型。
- 旧字段顺序来自 [Debian Gmsh 2.11.0 历史源码归档](https://archive.debian.org/debian/pool/main/g/gmsh/gmsh_2.11.0+dfsg1.orig.tar.xz) 内 `contrib/Parasolid/interface_parasolid/schema/sch_9008.sch_txt` 的只读核对。归档 SHA-256：`3814c4f28d5c13a05280e7bb02dd87030a904a96623f7b87aec312cdf4d5d006`；schema SHA-256：`b1b7a1812780dbbd841626c7cca2e49c0f3f99c7e15db9dd79016c00490c11a4`。这些历史文件不作为随包依赖、不提交、不复制整个表；其逐文件授权不由 Gmsh 项目名称推断。
- 官方 Gmsh 2.13.1 归档未包含该文件，GitHub 镜像候选路径返回 404，Debian sources 接口返回挑战页面；随后从 Debian archive 取得上述固定归档。
- 109 个模型的来源、SHA-256 和使用边界沿用本地 `asmith-hinges-inventory.json` 与 `asmith-hinges-source.json`；模型仍仅供本地评估。

## 验证

在 `data/external-assets/format-research/cadconvert` 下运行：

```powershell
cargo test --offline --manifest-path native/Cargo.toml -p xt-parser
cargo run --offline --manifest-path native/Cargo.toml -p xt-parser --example legacy_corpus -- <asmith-hinges绝对目录>
```

结果：15 项既有单测、4 项新增测试、1 项文档测试通过；全语料 `total=109 complete-stream=109 incomplete=0`。新增测试分别覆盖旧 BODY 边界、有效/无效 UTF-8 字节混合属性、缺失/非法/尾随记录及截断实体/终止符。

当前版本选择器仍按 schema major 选择标准布局。本轮正例只覆盖 `SCH_901000_9008`，不能外推全部 V9 小版本。原始流读尽也不证明拓扑引用闭合、面离散完整、孔洞、单位、装配变换或 source map 正确，产品质量档不据此提升。
