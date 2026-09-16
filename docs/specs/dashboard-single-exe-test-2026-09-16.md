# Dashboard 单 EXE 测试

供本机测试的 Windows 样例已从发布应用生成，包含作者保存的 37、91 两条柱图数据。接收端只需要 EXE，不需要 Node、ZIP 解压或启动脚本。

## 启动与测试

1. 从工作区 `test-output/dashboard-author-main-build-20260916/standalone/` 复制 `Dashboard.exe` 到一个空目录。
2. 双击 EXE，检查窗口能够打开并显示柱图；两条数据分别为 37、91，后者应更高。
3. 调整窗口大小，记录是否有空白、裁切或闪烁；关闭后重新打开，检查是否仍正常显示。
4. 需要查看许可时，在该目录执行 `.\Dashboard.exe --licenses`。

本次独立启动的 EXE SHA-256：`1a68ec0a154f56615c76aac5d6622ef76d99eb99f070a0c8f4493482b00e4af8`。

## 已验证与限制

真实链路覆盖磁盘发布、作者数据冻结、内容编译、Native 窗口呈现、HTTP 下载以及下载文件无参数启动。独立启动测试的 PATH 不含 Node，目录没有旁置资源；呈现后的恢复记录与下载内嵌运行包一致。证据位于 `test-output/dashboard-author-main-build-20260916/evidence.json` 与同目录的 `standalone-validation/evidence.json`。此次使用主线正常 API build 后的编译模块；验证脚本 `verify-dashboard-published-portable.mts` 的 `--sample-chart` 模式可复跑。

这是柱图交付链样例，能力状态为 `degraded`。缩放目检、完整界面视觉、点击筛选、跨页交互和故障恢复仍须继续验收；窗口能启动不代表这些项目通过。完整 KPI/表格页面正在接线。本样例不连接用户数据库，自动测试未覆盖登录流程。
