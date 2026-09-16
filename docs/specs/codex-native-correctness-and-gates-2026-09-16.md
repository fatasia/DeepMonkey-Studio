# Native 文本正确性与门禁恢复

本批对应接手计划 A/B，修复 GLM 交付的文本事务缺陷，并恢复 Native 工程门禁。完整剩余范围见 [接手计划](codex-takeover-audit-and-plan-2026-09-16.md)。

## 已完成

- 文本编辑按完整新字符串的 Unicode 字素边界重建样式、段落和内联对象位置；组合附加符、ZWJ emoji、旗帜、CRLF 均纳入回归。直接复用锁文件已有的 unicode-segmentation 1.13.3。
- IME undo/redo 同时恢复内容、元数据和光标；失败提交保留组合态，版本溢出原子拒绝。不可变快照共享文本与索引，历史仍受原条数预算限制。
- 旧文本 helper 修复非法选区、组合字符移动、选区收缩和 CRLF 行尾定位；换行布局修复软换行后宽度及硬换行处理。
- 行为总线按进入顺序淘汰幂等键；取消、超时、成功和应用失败共享有界终态身份窗口，窗口内拒绝 invocation 复用，防止迟到回调命中新事务。超时结算释放在途预算。
- 按文本事务、字体栅格、行为合同、图表连接、缓存准备、顶点传输和窗口生命周期拆分超限文件；保留原测试断言与 GPU 测试入口。

## 合同变化

`TextChange.previous_end_cluster` 表示修改前受影响区间的终点，原 `end_cluster` 表示修改后的终点；删除或字素合并时二者可以不同。`RevisionExhausted` 使版本耗尽成为显式错误，失败不修改文档、光标或历史。

`CommandBudget.max_cancelled_memory` 沿用原字段名，现为四种终态共享的 FIFO 容量；取消原因只在身份仍保留时可查询，取消记录被淘汰才增加 `cancel_memory_forgotten`。这不是永久去重，宿主在窗口外也不得复用旧 ID。

## 验证

| 检查 | 结果 |
| --- | --- |
| Native 独立导出全量 | 952 通过，60 忽略；忽略项按原条件保留 |
| Clippy | all-targets、all-features、`-D warnings` 通过 |
| 混合内容 GPU | 2 通过：CPU 参考像素、atlas 重载及坏候选保留 |
| 顶点传输 GPU | 2 通过：像素与旧缓冲、字节预算与旧帧保护 |
| 坐标重载 GPU | 1 通过：正常重载及失败候选保留原画面 |

复跑命令：

```powershell
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml --all --check
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --locked --all-targets --all-features -- -D warnings
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --locked --test deep2d_mixed_content_gpu_matrix -- --ignored --test-threads=1
```

独立导出从接手 HEAD 取基础夹具，只叠加本批 Native 源码和真实 ChartSpec 拒绝夹具；584 个 Native 文件与暂存区逐一一致。验证未依赖其他未提交 TS 生产代码。本机日志位于 `test-output/codex-native-export-test.log` 和 `test-output/codex-native-*-final.log`，不纳入版本库。包级体量门禁当前 0 阻断、10 条历史提示，仓库治理与全仓 800 行门禁通过。

## 本轮待办与项目级后验收

行为调用 ID 在 u64 耗尽以及手工 ID 与生成器冲突时的合同继续纳入 P1-21。完整 Dashboard、真实 IME 宿主、字体交付和正式发布仍按原计划推进。本批 GPU 读回只覆盖上述回归，不替代双主题、双分辨率、真实窗口交互及 V-01～V-05 验收。
