# Dashboard 离线播放器进程入口

供开发验证使用：读取已生成的 DMDA 包，校验 manifest 与 runtime bytes 后启动本地 Native 播放器。

在仓库根目录执行：

```powershell
pnpm exec tsx --conditions=development scripts/run-dashboard-client-native.mts C:\packages\dashboard.dmda --native-executable C:\players\deep-engine-native.exe
```

启动器只传入固定的 `--package` 参数和临时运行包路径，关闭 shell。播放器关闭后清理临时文件；Ctrl+C 终止子进程后清理。包中内容不能指定可执行文件或额外参数。

## 验证记录

- 通过归档、字节封装和 launcher 聚焦测试，覆盖同字节传递、取消、进程错误、非零退出、篡改拒绝与关闭后清理。
- CLI `--help` 在实际 tsx 环境运行通过，API 类型检查通过。
- 生命周期测试注入子进程事件，未作为真实 Native 正常窗口或 GPU 证据。

### 2026-09-16 真实窗口补验

本地 C2 producer 包通过现有通用窗口验证器。该验证器虽由 Scene 命名脚本导出，其实现接受有效 runtime package；无须复制窗口启动逻辑。工作区必须使用 `--conditions=development`，默认导出曾加载旧 dist 并以 `materialBindings: Unknown field` 拒绝当前包。

```powershell
pnpm exec tsx --conditions=development scripts/verify-scene-native-window.mjs test-output/c2-dashboard-ae22419-rerun/producer.package.json --native-executable packages/deep-engine-native/target/debug/deep-engine-native.exe --frames 3
```

结果：RTX 4060 Laptop / Vulkan，1200×800，实际 present 3 帧，GPU errors clean。本地报告 `test-output/c2-dashboard-ae22419-rerun/native-window-verification.log`。运行包字节 SHA-256 为 `948778ee0f8011c849c785633cccad139cd46b75be6c436214059baae0925076`，EXE SHA-256 为 `7f280c39b3fd88ecfdc798dae3509a5691b45bf1f85d243dc2dc31494b0864a2`。证据绑定此次 EXE，不推断其它构建版本。

手工查看同包：

```powershell
& ./packages/deep-engine-native/target/debug/deep-engine-native.exe --package ./test-output/c2-dashboard-ae22419-rerun/producer.package.json
```

检查 KPI、表格和 7/9 双柱，按 Esc 退出。此包是本地 producer 验证样本，尚非正式发布下载产物。窗口回执只证明加载和呈现，不包含逐节点像素、输入交互或字体身份覆盖；不能直接充作 C4 完整能力收据。系统截图与双轮视觉评分尚未完成，不宣称视觉验收通过。

## 本轮待办

正式发布入口尚未产出可下载 Dashboard 包。本入口仍要求工作区 Node/tsx 和单独安装的播放器；未实现原计划的独立 ZIP launcher、正式发布到离线正常窗口、双图表交互和恢复验收。DMDA 的 hash 校验用于内容一致性，不等同于可信发行签名。完整 C5 验收条件保持不变。
