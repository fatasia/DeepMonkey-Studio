# Deep2D P2-01 · X 兼容隔离首切片

日期：2026-09-17。范围：兼容开关、N0/X 隔离和无脚本受限宿主纯合同。

## 能力盘点与取舍

- N0 已有 `BehaviorPayload` 封闭命令、CAS/取消/预算总线；N1 已有认证 fixture 适配器；回放已有注入时钟与 SplitMix64 随机源。
- 当前依赖没有 JavaScript 引擎。本切片不增加依赖、不加载源码、不运行真实 JS，也不借 JSON/字符串绕开封闭枚举。
- X 使用独立 `compat_x` 模块。`CompatibilityLane::NativeN0` 在入口即拒绝，不能落入 X 执行器。

## 冻结合同

- 输入只含值类型资源字节、注入时钟、随机种子、封闭 pointer/key 事件与 `XCall` 调用树；没有 DOM、GPU、文件、网络或任意宿主对象。
- 请求 schema 显式冻结为 v1；未知版本在求值前拒绝。输入和候选输出都生成 canonical JSON SHA-256，浮点数以 IEEE-754 64 位十六进制写入 hash 视图，避免运行时十进制格式差异并保留 signed zero。
- `XCall` 首切片只允许 sequence、读时钟、抽随机、读已注入资源单字节、读已注入事件、发有限数值。
- CPU work units、输入+输出内存、调用深度、消息条数、消息字节、wall-clock 均为硬预算；宿主预算自身另有绝对上限，不能配置为无界。
- evaluate 只生成候选；publish 再核对 lane、开关、epoch、取消和 deadline。任一失败不发布部分消息，旧 epoch 保持不变。

## 已验证

- N0 隔离与关闭开关；资源/时钟/随机/事件双跑确定；六类预算；取消、迟到、旧 epoch；坏资源、坏事件、非有限数值。
- v1 固定样例 request hash：`3949234e2c2c9f208af935a277dff1bd2f0dd4de504c147d5368ba1b0d480853`；output hash：`05dde4e6e1f84655ff6662dde75e43b04059cebea550d00aa95d16c06db31437`。两次独立求值逐字一致，v2 请求 fail-closed。
- 本切片不是独立进程沙箱，也未认证 ZRender/ECharts；真实 X 进程与协议、崩溃隔离和依赖版本实验归 P2-02/P2-04。
