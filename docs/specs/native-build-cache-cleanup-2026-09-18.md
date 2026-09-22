# Native 调试符号缓存清理

本次磁盘满的主要可回收占用来自 Rust Windows 调试构建，不是模型素材。

首次盘点 `packages/deep-engine-native/target/debug/deps` 为 123.76 GiB，其中 875 个 PDB 占 113.16 GiB；`debug/incremental` 另占 9.03 GiB。不同构建哈希保留了同一测试目标的多份调试符号，单份最高约 287 MiB。并行构建期间数量仍会变化，因此盘点数量与执行时数量不同。

## 已执行

- 先移除一份已核对的旧 PDB（268.9 MiB）。
- 随后按目标名归组（去掉 Cargo 的 16 位哈希后缀），每组保留最近一份，逐文件删除 768 个历史 PDB，释放 **100.36 GiB**，当时保留 142 份。
- 用户自己的清理与本次操作合计使 D 盘可用空间回升到约 187 GiB；100.36 GiB 是本次删除文件长度的合计，不将用户释放空间计入本次成果。

源码、EXE、依赖库、原始素材、截图与验收证据未删除。PDB 不影响正常执行，但被删版本的源码级调试需要重新编译生成符号。`debug/incremental` 的整目录自动删除被执行环境拒绝，未计入已清理空间。

## 后续控制

`scripts/prune-native-debug-symbols.ps1` 默认只预览；显式 `-Apply` 才删除。它只处理确定目录中的历史 PDB，保留每个目标最新一份，并跳过最近 10 分钟变动的文件；检测到 debug 编译器则停止。不递归删除目录，也不清理 release、可执行文件或测试证据。

```powershell
./scripts/prune-native-debug-symbols.ps1
./scripts/prune-native-debug-symbols.ps1 -Apply
```

当前不更改 Cargo 的调试信息级别，避免为省空间削弱诊断能力或在收尾中触发大规模依赖重编。长时间测试批次结束后先预览重复符号，再定向清理；真实基线 EXE 与证据另行保留。
