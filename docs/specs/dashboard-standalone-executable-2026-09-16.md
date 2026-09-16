# Dashboard 单文件 Windows EXE

构建器将通过 DMDA 校验的同字节运行包嵌入支持 overlay 的 Native 播放器。接收方直接运行一个 EXE，无需 Node、脚本或旁置运行包。

```powershell
pnpm exec tsx --conditions=development scripts/package-dashboard-executable.mts dashboard.dmda --native-executable D:\player\deep-engine-native.exe --output D:\exports\dashboard.exe
```

输入播放器必须支持 `DMDASH01` overlay；已有 overlay 的 EXE 拒绝重复打包。输出必须为尚不存在的 `.exe`。运行包最多 256 MiB，基底播放器最多 512 MiB。

字节顺序：基底 EXE、UTF-8 许可 JSON、许可长度 u64LE、`DMLICS01`、原运行包、48 字节 footer。footer 为 `DMDASH01`、运行包长度 u64LE、运行包原字节 SHA-256。许可 JSON schema 为 `deep-engine.embedded-notices`，版本 1，包含完整 `license` 和 `thirdPartyNotices` 字符串，最多 8 MiB。

播放器支持 `dashboard.exe --licenses` 查看内嵌许可与第三方声明。运行包 SHA-256 用于完整性检查，不是发布者签名；追加 overlay 不保留原 EXE 签名有效性。打包测试使用结构夹具，不代替真实 Native 无参数启动、交互与离线恢复验收。
