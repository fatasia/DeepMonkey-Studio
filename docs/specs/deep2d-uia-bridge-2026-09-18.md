# P1-16 收官切片：Windows UIA 屏幕阅读器桥（2026-09-18）

对应 [Deep2D 剩余任务](deep2d-remaining-tasks-2026-09-16.md) P1-16 剩余项"OS 屏幕阅读器桥"（焦点环/语义树/键盘状态机已在此前批次完成）。

## 桥结构

- `native_ui/uia_bridge.rs`：纯逻辑层（角色→ControlType 映射、fail-closed 导航、环检测校验，全平台可测）+ `#[cfg(windows)]` COM 层——`#[implement]` 单 provider 类同时实现 IRawElementProviderSimple/Fragment/FragmentRoot，根经 `UiaReturnRawElementProvider` 挂 HWND（子类化 WNDPROC 截 `WM_GETOBJECT`）。属性暴露 Name/ControlType/Value/FrameworkId/ProcessId/NativeWindowHandle/IsControlElement/IsKeyboardFocusable。
- 线程模型：仅 `ProviderOptions_ServerSideProvider`（UseComThreading 实测注册异常后移除，与 AccessKit/Chromium 一致）；语义树在 `Arc<RwLock>` 后，COM 入口全部 `catch_unwind` 收敛为失败 HRESULT（回调内 panic 即进程崩溃）；换树 → `UiaRaiseAutomationEvent(StructureChanged)`（100ms 节流）+ 属性变更事件，锁释放后才 raise；detach 幂等（WM_DESTROY 自清 + 二次 detach no-op 已测）。
- 依赖决策：windows-sys 0.61.2 只有 UIA 自由函数、零 COM 接口定义；改用 Cargo.lock 中已有的 `windows =0.62.2`（wgpu 传递依赖，同版本仅加 feature）+ `windows-core`（implement 宏要求），零新包，`cargo check --locked` 通过。

## Smoke 证据（真实 Win32 窗口）

`--smoke-uia` PASS：attach 后 MTA worker 以 CUIAutomation `FindAll(Subtree)` 枚举 6 个内容节点全中——`Pane 'Deep Engine'`、`Group '电池产量趋势图'`、`Group 'chart legend'`、`ListItem 'Series A/Series B…'`、`Text '状态'`（另 6 个 OS 窗口 chrome 元素非语义树）。关键实现点：provider 须经 `NativeWindowHandle` 属性绑定，缺它整树不可见。

## 门禁

lib 341（含 5 项 uia_bridge 单测）/ bin 126 全绿；clippy `-D warnings --all-targets --all-features` 干净；fmt 干净；`check --locked` 绿。

## 边界（如实声明）

- Narrator / Accessibility Insights 真人朗读未做（后续人工步骤；进程内 client 已验证枚举）。
- Control Pattern（Invoke/Value）与 BoundingRectangle/焦点路由未实现——fail-closed：GetPatternProvider 返回 NULL、SetFocus 返回 E_NOTIMPL、bounds 返回零矩形。
- winit 产品窗口接线未做（挂点已明确：`app/lifecycle.rs::resumed` 取 rwh_06 hwnd 调 `UiaBridge::attach`，包更新处调 `replace_semantics`）。
- stale-provider 路径仅构造性验证；uia_bridge.rs 717 行超 500 行预警线（COM 三接口 trait 实现的不可拆约定，已知晓）。
