# Dashboard 单文件 Windows EXE

构建器将通过 DMDA 校验的同字节运行包嵌入支持 overlay 的 Native 播放器。接收方直接运行一个 EXE，无需 Node、脚本或旁置运行包。

```powershell
pnpm exec tsx --conditions=development scripts/package-dashboard-executable.mts dashboard.dmda --native-executable D:\player\deep-engine-native.exe --output D:\exports\dashboard.exe
```

输入播放器必须支持 `DMDASH01` overlay；已有 overlay 的 EXE 拒绝重复打包。输出必须为尚不存在的 `.exe`。运行包最多 256 MiB，基底播放器最多 512 MiB。

字节顺序：基底 EXE、UTF-8 许可 JSON、许可长度 u64LE、`DMLICS01`、原运行包、48 字节 footer。footer 为 `DMDASH01`、运行包长度 u64LE、运行包原字节 SHA-256。许可 JSON schema 为 `deep-engine.embedded-notices`，版本 1，包含完整 `license` 和 `thirdPartyNotices` 字符串，最多 8 MiB。

播放器支持 `dashboard.exe --licenses` 查看内嵌许可与第三方声明。运行包 SHA-256 用于完整性检查，不是发布者签名；追加 overlay 不保留原 EXE 签名有效性。打包测试使用结构夹具，不代替真实 Native 无参数启动、交互与离线恢复验收。

## 主线无参数启动验证

2026-09-16：主线 EXE 在只有 `Dashboard.exe` 的目录启动成功。测试子进程 PATH 仅含 Windows System32，LOCALAPPDATA 使用隔离目录；呈现后的恢复记录与原运行包字节及 packageHash 一致，启动目录没有产生依赖文件。验证脚本：`node scripts/verify-dashboard-standalone.mjs <EXE> <预期运行包JSON> <新证据目录>`。测试运行器需要 Node，待测 EXE 不需要。

样例只有两个形状，不代表完整 Dashboard 或视觉验收；验证器在成功呈现并写入恢复记录后终止进程。
部署已固定 `nativeExecutable` 时，候选支持 `GET /api/projects/:projectId/applications/:applicationId/dashboard-candidates/:candidateId/standalone-executable`，返回单个 `.exe` 附件，类型为 `application/vnd.microsoft.portable-executable`。客户端不能提供播放器路径或其它查询参数。下载沿用候选权限、项目/应用范围、TTL 与撤销校验，并在异步打包后再次检查有效性；旧 ZIP 与 DMDA 下载保留。

正式启动从编译器配置的 `nativeSha256` 固定播放器身份，并传至 ZIP/EXE 下载。打包器对实际读入并用于输出的同一份 EXE 字节计算 SHA-256；部署后原路径被重新构建或替换会拒绝下载，需要重新部署。通用构建 API 保留可选 `expectedSha256`，正式启动不能省略此绑定。
