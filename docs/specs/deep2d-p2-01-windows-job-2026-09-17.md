# Deep2D P2-01 Windows 进程树与资源限制

日期：2026-09-17。承接 [单次 IPC 切片](deep2d-p2-01-process-ipc-2026-09-17.md)，补齐 Windows worker 衍生进程与继承管道治理；restricted token 与正式产品接线仍待完成。

## 实现与边界

- 创建匿名、不继承的 Job，设置 kill-on-close、禁止 breakaway。worker 以 `CREATE_SUSPENDED` 启动，先绑定 Job，再恢复唯一初始线程；绑定或恢复失败时 RAII 终止并回收，worker 没有绑定前执行用户指令的窗口。
- `XProcessLimits` 独立于 `XBudget`：默认每进程 committed memory 128 MiB、整 Job 256 MiB、最多 8 个活动进程、累计用户态 CPU 2,000 ms。配置有绝对上限与非法值拒绝；不把逻辑内存或 work units 当成操作系统计量。
- `evaluate_with_config` 可显式配置 OS 限额，原调用入口复用默认值。成功、取消、超时、错误和根 worker 提前退出均终止整 Job。等待活动进程归零与 I/O 线程结束分别最多 250 ms；清理失败给出独立错误，不伪称已回收。
- 协议编解码抽为 `process_ipc.rs`，进程编排、Windows Job 和初始线程获取分开维护。复用锁定的 `windows-sys 0.61.2`；直接依赖增加的是已有版本的 Windows API features，无新第三方版本。

Job Object 负责进程树和资源治理，不限制文件或网络权限。当前仍只运行可信封闭 ABI worker；不因本片开放任意 JS、DOM、外部可执行文件或用户提供的启动命令。

## 真实验证

```powershell
cargo build --manifest-path packages/deep-engine-native/Cargo.toml --example x_compat_worker --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_process --test compat_x_windows_job --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --lib compat_x --offline
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --lib --test compat_x_process --test compat_x_windows_job --example x_compat_worker --offline -- -D warnings
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml -- --check
```

Windows 集成覆盖真实根/子/孙三层进程：根 worker 退出，子/孙保留继承管道，宿主取消后逐 PID 核验退出。PID 不存在仅接受 `ERROR_INVALID_PARAMETER`，其他查询错误视为失败；每轮使用独立临时目录，拒绝复用旧故障文件。

最终默认并行实测：IPC **7 通过**、Windows Job **4 通过**、库聚焦 **10 通过**；两套集成各 5 个 ignored 是由父测试按名称启动的子进程故障夹具。IPC/Windows 两套分别耗时 0.29/0.35 秒。clippy、fmt 与范围 diff 检查通过。

资源限制另验证：禁止 `CREATE_BREAKAWAY_FROM_JOB` 逃逸；256 MiB 单次提交被 128 MiB 进程限额拒绝；活动进程限额设为 1 后创建子进程失败；50 ms 累计用户态 CPU 限额终止忙循环，早于独立的 6 秒 wall-clock 保护。仅靠 Windows 的 JOB_TIME 周期终止出现过延迟，因此宿主同步读取内核 `TotalUserTime`，越限主动终止 Job 并给出 `ProcessCpuBudgetExceeded`；CPU 计量仍来自操作系统，独立于 wall-clock 与 work units。库测试还通过内核查询读回全部限额，核验默认值与非法配置拒绝。

## 启动性能修复

首版使用 ToolHelp 全系统线程快照，默认并行测试时从 spawn 至恢复阶段耗时约 800–900 ms，触发原有 100 ms deadline 测试。改用官方 `PssCaptureSnapshot(PSS_CAPTURE_THREADS)` 只采集目标进程初始线程后，同轮该阶段约 0.3–0.4 ms，原有 7 项 IPC 测试在不放宽时限的条件下通过。上述为本机诊断插桩结果，插桩已移除，不作为跨设备性能承诺。

对应官方接口：[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[累计 CPU 与内存限额](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)、[目标进程快照](https://learn.microsoft.com/en-us/windows/win32/api/processsnapshot/nf-processsnapshot-psscapturesnapshot)、[快照线程信息](https://learn.microsoft.com/en-us/windows/win32/api/processsnapshot/ns-processsnapshot-pss_thread_entry)。PSS 最低系统为 Windows 8.1，本项目 Windows 目标在该范围内。

快照和游标分别以 RAII 释放；[PssFreeSnapshot 官方说明](https://learn.microsoft.com/zh-cn/windows/win32/api/processsnapshot/nf-processsnapshot-pssfreesnapshot) 明确本地调用捕获的快照以 `GetCurrentProcess` 释放，本实现遵循该约定。

## 仍待完成

restricted token/文件网络权限边界、正式安装包与播放器调度、真实脚本/Painter 接线及相应认证。当前切片完成不关闭完整 P2-01/P2。
