# JT Windows Job 资源与进程树治理

2026-09-18。JT 的 Windows reader 由随 API 分发的本地 host 托管，复用 Native `compat_x/windows_job.rs`，没有第二套任务总线。

## 实现

- reader 以 suspended 状态创建，加入 Job 后才恢复执行。Job 设置 kill-on-close；正常结束、取消、超时和错误都在确认整树 `ActiveProcesses = 0` 后返回。
- host 持有父 API 的 process HANDLE，检查其退出状态，避免 PID 重用；stdin 断开也触发回收。取消先走控制通道，2 秒无响应才强杀 host，由内核关闭 Job 回收整树。
- 预算来自同一 provider manifest：30 分钟、16 GiB 提交内存上限、100% CPU 预算，最多 4 个树内进程。累计 CPU 上限按 `timeoutMs * maxCpuPercent / 100` 计算，不是瞬时 CPU 百分比节流。16 GiB 是配置上限，不是实测 RSS；原有 V8 1 GiB 堆限制独立保留。
- 请求最多 32 KiB，响应最多 16 KiB。父进程继续负责实物哈希、质量档与发布校验；成功响应必须等 host 退出才接受。
- X reader 原有 512 MiB / 1 GiB / 60 秒限制及验证保持不变。非 Windows 仍是可终止进程隔离，不宣称 Windows Job 能力；Windows 缺 host 明确失败。

## 离线分发

`scripts/build-industrial-worker-host.mjs` 使用 `--offline --locked -j2` 和静态 CRT，复用 portable target，复制 EXE 与构建身份清单到 `apps/api/dist/industrial-worker/`。API build/predev 保留原有脚本并追加该步骤；运行机器不需要 Rust 工具链。

本次 host 611,840 字节，SHA-256：`888f90110c999bf491c8979c625b0e2781a8741f44b7a92f69878b85c837cfe1`。现有 portable purity 检查通过：Windows PE、静态 CRT，无 VCRUNTIME/MSVCP/browser 标记。

## 验证

- API 5 个专项文件 41 项通过，其中 8 项真实 Job 用例覆盖成功退出、取消、强杀 host、父 API 被杀、累计 CPU 超限、128 MiB 内存超限、reader 崩溃与整树墙钟超时；包含 reader 的真实孙进程。
- Native Job 聚焦测试 2 项通过：非法预算拒绝、内核实际限制与禁止 breakaway。
- 生产 JS 入口实际启动 dist host 和 dist reader，转换真实 ExampleBlock JT 10.3：9 segments、11 nodes、1 mesh、1 instance、12 triangles。GLB SHA-256 `d16c470eb9c84de2b59d51c272a797f731806a592deb7f8e9df706c8306fef43`，与此前 fork 产物字节一致。证据：`test-output/industrial-jt-job-production-20260918/`。
- API typecheck、生产 TypeScript 编译、source-size 4,985 文件门禁及 diff whitespace 检查通过。

## 剩余差额

Job 不等于受限令牌或文件/网络权限沙箱；其他格式 reader 尚未全部接入。多实例租约仍需在既有 MetadataStore 的 Postgres 整文档写入上解决 CAS，不能把单进程原子发布视为多实例一致性完成。完整 S1 仍未整阶段关闭。
