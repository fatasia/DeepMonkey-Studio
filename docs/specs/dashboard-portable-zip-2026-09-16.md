# Dashboard Windows portable ZIP

构建器将已通过 DMDA 校验的 Dashboard 和显式指定的本地 Native EXE 打包，接收方无需 Node.js。

```powershell
pnpm exec tsx --conditions=development scripts/package-dashboard-portable.mts dashboard.dmda --native-executable D:\player\deep-native-player.exe --output D:\exports\dashboard.zip
```

输出文件必须不存在。ZIP 包含同字节 `runtime-package.json`、`deep-native-player.exe`、`manifest.json`、`Start-Dashboard.ps1`、使用说明、项目许可证与现有第三方声明。沿用 JSZip 3.10.1；无新增依赖、无许可证政策变更。

接收方完整解压后运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Dashboard.ps1
```

启动器检查固定文件集合的 SHA-256，拒绝额外参数、变更过的 payload hash、文件篡改与链接文件，然后仅传入固定 `--package` 与解压目录内的运行包路径。`artifactSha256` 是文件字节 hash；`runtimePackageSha256` 保留包内身份，两者不能混用。Hash 用于文件完整性检查，不是发布者签名。

验证：独立工作树四项测试通过，包括 ZIP 实际解析/CRC/全文件 hash、DMDA/EXE 错误与取消、真实 PowerShell 拒绝路径，以及 PowerShell 启动临时编译的 Windows 测试 EXE 并检查实际参数（路径含空格）。启动测试曾复现包内身份误用作文件 hash，修正后通过。API 类型检查通过。

测试 EXE 与结构夹具只验证打包和启动机制；当前不代表正式发布下载、真实 Dashboard Native 窗口、完整交互或离线恢复验收完成。EXE 由打包者显式选择，当前 PE 检查不证明该 EXE 的版本、来源或窗口能力；正式发布仍需绑定受验证的播放器身份与第三方分发清单。
