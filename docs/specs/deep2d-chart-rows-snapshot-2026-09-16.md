# Chart 数据快照共享

Native 数据事务复用未修改数据集的行存储，降低局部刷新创建候选源的复制成本。

## 存储与合同

`ChartDataset.rows` 使用 `ChartRows`，内部为 `Arc<Vec<Vec<ChartValue>>>`。克隆 ChartIR 只复制数据集元信息并增加行存储引用；写入单元格或增删行经 `Arc::make_mut` 分离当前数据集。没有历史快照链，最后一个持有者释放后回收行数据。

JSON 仍是 v1 二维数组，字段、值、顺序及严格 ChartIR 校验不变，无新增依赖。Rust 构造器接受 `Vec` 时需 `.into()`，迭代器可直接 `collect()`；借用读取及可变索引保持原用法。需要拥有 `Vec` 的消息生产者使用 `.to_vec()`。

数据更新仍先验证全部输入，再创建候选和校验完整 ChartIR。替换只安装新行，未变化数据集共享旧存储。窗口追加仅复制保留的旧行，传入新行直接移动；不淘汰任何行的空追加直接复用源。来源、版本、行身份迁移和 GPU 候选失败回退沿用现有事务。

## 验证

新增五项测试覆盖实际存储共享、嵌套单元格写隔离、完整序列化回放、成功更新、空追加与跨窗口淘汰、候选语义失败后的源/状态/几何保持。既有 TS→Native 数据消息与 sim 回放继续比较完整 ChartIR。

基准只计创建源快照，不包含行更新、校验、几何、文字或 GPU。旧方式在同轮复现逐单元复制；额外包含当前元数据 clone 的每数据集一次 Arc clone。i9-12900HX Release，8数据集×8192行、4列混合数值/中文，5轮预热、20次交替采样：逐单元复制中位25.5731ms/P95 30.0249ms，共享快照中位0.0124ms/P95 0.0207ms。结果限于本机该夹具的源快照阶段。

```powershell
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --release --test chart_rows_snapshot benchmark_source_snapshot_copy -- --ignored --nocapture
```

## 剩余开销

这一步按数据集共享行；单个已共享数据集发生任意可变访问，仍复制其全部行。窗口保留行也仍复制，完整 ChartIR 校验仍运行。列式分块、局部语义校验和全局 Epoch 继续待办；既有 `ChunkedSeries` 尚未接入混合值数据集。没有端到端 FPS 或总显存结论。

同一8×8192夹具的完整重复校验中位4.7761ms/P95 7.2712ms（Release，5预热/20样本），见 `benchmark_repeated_source_validation`。行统计缓存未实现；此结果为下一片基线。00:30交接后剩余工作统一见[剩余任务总表](deep2d-remaining-tasks-2026-09-16.md)。
