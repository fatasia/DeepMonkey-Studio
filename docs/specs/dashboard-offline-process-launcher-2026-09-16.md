# Dashboard 离线播放器进程入口

供开发验证使用：读取已生成的 DMDA 包，校验 manifest 与 runtime bytes 后启动本地 Native 播放器。

在仓库根目录执行：

```powershell
pnpm exec tsx scripts/run-dashboard-client-native.mts C:\packages\dashboard.dmda --native-executable C:\players\deep-engine-native.exe
```

启动器只传入固定的 `--package` 参数和临时运行包路径，关闭 shell。播放器关闭后清理临时文件；Ctrl+C 终止子进程后清理。包中内容不能指定可执行文件或额外参数。

## 验证记录

- 通过归档、字节封装和 launcher 聚焦测试，覆盖同字节传递、取消、进程错误、非零退出、篡改拒绝与关闭后清理。
- CLI `--help` 在实际 tsx 环境运行通过，API 类型检查通过。
- 生命周期测试注入子进程事件，未作为真实 Native 正常窗口或 GPU 证据。

## 本轮待办

正式发布入口尚未产出可下载 Dashboard 包。本入口仍要求工作区 Node/tsx 和单独安装的播放器；未实现原计划的独立 ZIP launcher、正式发布到离线正常窗口、双图表交互和恢复验收。DMDA 的 hash 校验用于内容一致性，不等同于可信发行签名。完整 C5 验收条件保持不变。
