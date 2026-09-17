# P2-01：Windows LPAC 封闭 worker 实验

本片为可信宿主提供 Windows 零 capability LPAC 启动入口，复用 X IPC 和 Job 资源治理；尚未接产品发布/编辑器链。

## 实现

- `process::lpac::evaluate` 复用请求预算、规范 hash、回执校验及 epoch/取消检查。`exchange` 仅供可信宿主的固定 probe，不能向 X 脚本暴露路径或原始字节执行接口。
- 每次创建唯一 AppContainer profile 和独占临时目录；只复制宿主指定的固定 worker，为新 SID 授予该新目录和文件 RX。没有修改仓库、模型或已有目录 ACL。
- `CreateProcessW` 使用零 capabilities、`ALL_APPLICATION_PACKAGES_OPT_OUT`、精确标准流 handle list 和 Job list；挂起创建，核验身份后恢复。Job 在创建时加入，无 spawn→assign 竞态；失败不降级普通进程。
- 环境仅传 `APPDATA`、`LOCALAPPDATA`、`SystemRoot`、`USERPROFILE`，不继承 PATH、令牌或任意宿主环境。空环境/仅 SystemRoot 在本机 CreateProcess 返回 203；Windows profile 环境重定向需要这些基础位置。
- 显式清理覆盖复制失败、启动失败、正常退出、取消和超时；profile 删除失败作为错误返回。析构仅作为第二次 best-effort 防线。Job/管道采用既有有界回收。

## 身份与平台证据

Windows 11 Home 22621 上 `TokenIsLessPrivilegedAppContainer` 查询返回 Win32 87；直接 native 查询也返回 `STATUS_INVALID_INFO_CLASS`。该结果说明本机不支持此查询，不能据此推断系统不支持 LPAC；没有使用未文档化 class。

本实现按微软文档规定的 LPAC opt-out 启动属性执行，并在恢复线程前检查 `TokenIsAppContainer=1`、精确 profile SID、`TokenCapabilities` 为空和 `TokenGroups` 中没有启用的 ALL_APPLICATION_PACKAGES SID。所有实际采用的查询失败均拒绝启动。该检查不替代跨 Windows 版本的 ACL 行为矩阵。

本机动态 CRT worker 退出 `0xc0000022`：VCRUNTIME140.dll 的本机 ACL 不含 LPAC 读取授权。实验 worker 改用 `-C target-feature=+crt-static` 编译后 IPC 通过；没有放宽系统 DLL ACL、增加 capability 或复制系统 DLL。正式打包仍需固定静态 CRT 构建与依赖审计。

## 已验证

`compat_x_lpac`：4 项通过。

1. 静态 CRT 的真实 X worker 双向 stdin/stdout 回执，与宿主求值完整 candidate/hash 一致。
2. 宿主私有 canary 的读/写打开在普通进程成功，在 LPAC 均返回 Win32 5；内容不变。宿主 TCP 监听和普通进程连接在前后均成功。
3. 缺失文件的复制失败、非 PE 文件的 CreateProcess 失败、在途取消，均拒绝且清理 scratch。
4. 真实睡眠 worker 超时终止，返回 wall-clock budget 错误，3 秒内返回且清理 scratch。

网络 probe 显式调用 WSAStartup，避免 Rust std::net 在初始化错误上 panic。本机 LPAC 返回 10107 (`WSASYSCALLFAILURE`)，因此未进入 connect；普通进程初始化和连接均成功。测试也接受初始化成功后明确的 connect 10013，但不接受连接超时作为拒绝证据。本机结果只计网络初始化负向对照，不计完整出站网络隔离验收。

测试检查本进程唯一前缀 scratch 无残留；生产清理调用 DeleteAppContainerProfile 并检查 HRESULT。未独立枚举注册表证明 profile 注册项删除，也未注入删除失败。

既有 IPC 集成 7 通过 / 5 个 child-only fixture 忽略，Windows Job 集成 4 通过 / 5 个 child-only fixture 忽略；fixture 由对应父测试实际运行。`clippy --lib --test compat_x_lpac --example x_lpac_probe -- -D warnings` 通过。

## 复跑

```powershell
cargo rustc --manifest-path packages/deep-engine-native/Cargo.toml --example x_compat_worker --offline -- -C target-feature=+crt-static
cargo rustc --manifest-path packages/deep-engine-native/Cargo.toml --example x_lpac_probe --offline -- -C target-feature=+crt-static
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --test compat_x_lpac --test compat_x_process --test compat_x_windows_job --offline
cargo test --manifest-path packages/deep-engine-native/Cargo.toml --lib compat_x --offline
cargo clippy --manifest-path packages/deep-engine-native/Cargo.toml --lib --test compat_x_lpac --example x_lpac_probe --offline -- -D warnings
cargo fmt --manifest-path packages/deep-engine-native/Cargo.toml --check
```

普通 `cargo build --examples` 会覆盖静态 CRT 实验产物，复跑前须执行上述两个 rustc 命令。

## 本轮待办

- LPAC 身份行为矩阵：ALL_APPLICATION_PACKAGES-only ACL 的普通 AppContainer 正对照、注册表、命名对象和继承句柄对抗测试。
- TCP/UDP、IPv4/IPv6、DNS、局域网与出站网络负向矩阵；不添加 loopback 豁免。
- 独立确认 profile 注册删除、宿主崩溃后的 orphan 清理，以及清理失败注入。
- 正式固定 worker 产物与产品接线。零 capabilities 不等于没有任何可读文件或可写空间：程序/系统运行库仍需读取，AppContainer 私有存储仍存在。

此片不完成整个 P2，不引入 JS/DOM，不放宽 N0。沿用已固定的 windows-sys 0.61.2，只增 Win32 feature，无新增第三方包。

## 官方依据

- [Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)：LPAC opt-out、profile 与环境重定向。
- [TOKEN_INFORMATION_CLASS](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class)：身份、SID 和 capability 查询合同。
- [WSAStartup](https://learn.microsoft.com/en-us/windows/win32/api/winsock/nf-winsock-wsastartup)：初始化失败直接返回错误码，不能冒充 connect 结果。
- [PssFreeSnapshot](https://learn.microsoft.com/zh-cn/windows/win32/api/processsnapshot/nf-processsnapshot-pssfreesnapshot)：既有普通进程 Job 路径的本地 snapshot 回收依据。
