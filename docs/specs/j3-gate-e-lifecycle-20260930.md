# J3 Gate E 生命周期首刀

日期：2026-09-30。范围：两个真实宿主生命周期组件的 CPU 发布轨迹、取消和资源回收；GPU 验收另列。

## 现状核查

已检查源码（包括未跟踪文件）、contracts/types、package.json/Cargo.toml、消费方、测试证据、规格和恢复台账。

- **已有（不重建）**：TS `RuntimeResourcePrewarmExecutor` 已被 `DashboardCandidateController` 与预热执行器消费，支持资源去重、原子提交、latest-wins、迟到加载释放、取消及幂等 dispose。原有 resourcePrewarmLifecycle/Commit 测试覆盖这些路径。
- **已有（不重建）**：native `UpdateCoalescer`、`PublishedState`、`LatestMailbox`、`WatchThread` 由 packet_live/package_live 和窗口生命周期实际消费；恢复仅使用最后完整发布的内容。
- **已有（不重建）**：serde_json、Vitest、esbuild 均已安装；不增加依赖。contracts 中脚本/仿真生命周期不是资源发布合同，不挪用或复制。
- **真实缺口**：Gate E 尚无双方共同阶段枚举、转移表、同形轨迹或比较入口；已有单端测试不能替代对拍。
- **真实缺陷**：native `staged(generation)` 仅排除小于最高提交的代次，未提交的未来代次会获得 Publish。修为必须等于最高提交，增加回归测试。

## 合同与执行路径

`packages/deep-engine/fixtures/j3-lifecycle-v1.json` 唯一登记阶段、转移表、五个情景及预期轨迹。阶段按请求记录：staging → committed/failed/superseded/cancelled；disposed 是宿主终态，晚到请求可以记录 superseded，不能重新提交。所有终态检查 active generation 与实际 CPU 资源计数。

TS 调用生产 `RuntimeResourcePrewarmExecutor`，通过真实 adapter 的 load/commit/release 边界观察资源；native 集成测试直接 `#[path]` 引用生产 coalescer、PublishedState、mailbox 与 WatchThread，不另建状态机。测试资源使用 TS 对象和 Rust Arc/Drop 计数，native 发布使用生产 mailbox 原子锁与 PublishedState 交换，取消使用生产 watcher 停止/回收。

五个情景：成功更新；prepare 失败保留旧包；新代次提交后旧代次晚到被拒绝；取消不发布；pending 中 dispose 后晚到资源释放、重复 dispose/Drop 后资源为零。

`scripts/j3-lifecycle-parity.mjs --web-only` 输出 TS 轨迹；`J3_NATIVE_LIFECYCLE_OUTPUT_PATH` 指定 native 测试输出；`--compare` 读取两腿并检查合同及逐字段一致。默认入口串行执行两腿。共同比较是生命周期语义与 CPU 资源数量，不要求两宿主使用同一内部类。

## 验收边界

CPU 首刀通过要求：全部预注册轨迹相等，所有终态资源回收正确，取消和失败保留旧包，迟到结果不覆盖新包，dispose 后为零；同一腿连续两次结果一致。

GPU device lost/recovery、真实显存计数、upload bytes、首个有效帧和 CPU/GPU 帧时未纳入本首刀；CPU 资源计数不得写成显存证据。正式 Gate E 完成需补真实设备丢失与渲染资源读数。本任务不生成 UI/3D 画面，视觉验收不适用于 CPU 门本身。

## 验收记录

- `pnpm exec vitest run lab/j3LifecycleProbe.test.ts src/runtimePackage/resourcePrewarmLifecycle.test.ts src/runtimePackage/resourcePrewarmCommit.test.ts`（deep-engine 包目录）：3 文件、12 测通过。
- `node --test scripts/lib/j3LifecycleParity.test.mjs`：5 测通过，包含缺腿、泄漏、过期合同和非法转移拒绝。
- `pnpm exec tsc -p tsconfig.lab.json`：通过；native 修改经 rustfmt。
- 主线串行执行 `node scripts/j3-lifecycle-parity.mjs`：TS/native 5 情景 × 2 轮逐字段相等，每轮 28 条阶段样本；native 12 测通过，dispose 后 CPU 资源数 0。
- `node scripts/j3-lifecycle-parity.mjs --compare`：证据复核通过。证据目录 `test-output/interrupted-0930/lifecycle-parity/` 含 fixture 快照、web.json、native.json、native.log 和 evidence.json。

首刀已通过，正式 Gate E 保持部分完成。GPU 丢失恢复、显存、上传量、首帧、帧时仍未测；native 此次构建存在现有 unused/dead_code 警告，未开展无关清理。

TS cancelled 来自实际 AbortSignal + executor aborted 结果；native cancelled 来自实际 WatchThread 停止后未入 mailbox。两者在共同合同中归一为取消保留旧包，但不把取消读入阶段等同于 GPU 上传取消。TS 资源计数来自 adapter.release，native 计数来自测试 payload 的 Arc/Drop；两者均为 CPU 测试资源，不证明整个播放器或 GPU 无泄漏。
