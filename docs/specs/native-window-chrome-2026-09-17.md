# 独立客户端标题栏与全屏

独立场景／大屏 EXE 使用深色原生标题栏，参考 Unity 的低装饰工作区风格，不引入 WebView 或自绘窗口控件。Windows 管理拖拽、缩放、窗口按钮与 DPI；原生非客户区使用系统深色主题，不复制 Web CSS 色值。

- 标题以 EXE 文件名为应用名；通用播放器显示 Deep Monkey。正常状态移除 wgpu 技术说明，显示 F11 全屏提示；其他操作保留应用名前缀和状态。
- F11 切换当前屏幕无边框全屏，按键重复不重复切换。Esc 先交给现有标注/图例取消，再退出全屏；窗口模式仍沿用原 Esc 关闭行为。
- 不改 Studio 桌面编辑器，不增加包依赖。已有发布 EXE 需要重新打包才能包含本次代码。

## Release 单 EXE 复验

当前播放器已完成静态 CRT Release 重打，27项 smoke、44项分发清单和纯度检查通过。证据目录 `test-output/native-chrome-delivery-20260917-r2/`，ZIP SHA-256 `f35318e1223e7e87ac7e0fd53c9167a9ba170f7e43e91b315edd50b3eb804e11`。首次构建期间验证脚本变更被输入指纹门禁拒绝；该产物不计交付。

隔离真实发布图表→冻结→Native验证→下载→无参数EXE呈现通过，产物 `test-output/dashboard-chrome-release-20260917-r1/standalone/Dashboard.exe`，SHA-256 `f7d8f9fa492198a115510cc0dbb0ba6804c7f4488aaff37d02869f5a0b94ba12`。这是验收图表，不是客户项目。

窗口脚本省略 `-Package` 可直接验证单文件；`test-output/standalone-chrome-20260917-r1/evidence.json` 绑定EXE哈希并记录两档窗口原始/全屏/恢复边界，标题为 `Dashboard | F11 全屏`。载荷篡改、长度越界、尾部截断均拒绝且恢复文件不变，恢复原EXE后再次呈现，证据 `test-output/chrome-release-recovery-20260917-r2/`。首次故障脚本遇到EBUSY，确认无残存Dashboard进程后新目录复跑通过；不将首次运行计作通过。

## 验证与视觉边界

`cargo test --bin deep-engine-native`：124 passed / 43 ignored；新增两项标题/快捷键合同测试。clippy、debug build、repository gate 通过。

`scripts/verify-window-chrome.ps1` 对真实 Windows 窗口发送 F11/Esc，在 960 和 520 px 宽下检查全屏扩大、退出后位置尺寸精确恢复、进程未退出。场景与已发布 Dashboard runtime 均通过。

两轮有效场景截图位于 `test-output/window-chrome-20260917-r3/` 与 `r4/`；Dashboard 位于 `test-output/window-chrome-dashboard-20260917-r1/`。r1 截到锁屏、r2 受 DPI 虚拟化裁切，均不作为视觉通过证据；脚本改为捕获目标窗口并使用 per-monitor DPI 后复检。

design-taste-digitaltwin 复检仅针对标题栏：布局9、令牌9（系统主题）、排版9、信息层级9、语义9；交互状态/反馈/响应式与主题各8（真实键盘窗口行为已测，锁屏环境尚未验证活动窗口按钮 hover、点击及浅色系统组合）；动效与3D画质不适用。本片未达到完整视觉闭环验收，保留这些实机检查，不以场景渲染截图替代。
