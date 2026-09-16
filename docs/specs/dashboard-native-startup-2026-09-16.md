# Dashboard Native 部署入口

API 可从服务端配置注册 Dashboard 候选和 Windows 单 EXE、ZIP、DMDA 下载。没有配置时不注册这些入口；配置错误会中止启动。

从工作区根目录按依赖顺序构建 API：

```powershell
pnpm --filter @bim-studio/api... build
```

API `build` 在清理 dist、执行 TypeScript 编译后自动生成 Dashboard 编译及窗口验证 bundle；`predev` 也会生成该 bundle。无需生产构建后手动补文件。生产 Node 使用依赖包的 dist 导出，因此 contracts、data-runtime、deep-engine 等工作区依赖也必须先正常构建，不能用开发源码导出代替。

部署 JSON 使用绝对路径，包含：

```json
{
  "nativeExecutable": "D:/deployment/deep-engine-native.exe",
  "expectedDeviceFingerprintSha256": "填写该验证主机实际窗口回执的64位设备指纹",
  "configuration": { "locale": "zh-CN", "packageVersion": "1.0.0" }
}
```

在启动 API 的同一 PowerShell 进程设置配置文件路径；不需要修改 `.env`：

```powershell
$env:DASHBOARD_NATIVE_DEPLOYMENT_FILE = 'D:/deployment/dashboard-native.json'
pnpm --filter @bim-studio/api dev
```

生产构建完成后，可检查普通 Node 能否加载 startup 与 bundle 并注册受鉴权保护的三个下载入口：

```powershell
node scripts/verify-dashboard-production-build.mjs D:/deployment/deep-engine-native.exe <实际设备指纹>
```

该检查使用隔离临时存储，不执行 GPU 窗口或修改用户数据；窗口与完整发布验证另行执行。

文字节点还需要 `fontCatalog`，其字段见 `apps/api/src/dashboardPublishedFontCatalog.ts`。目录绑定项目、应用及发布 revision，字体从该项目私有对象存储读取，必须指定真实 SHA-256、face、再分发许可依据、有序字体引用和完整继承文字样式。目录样式进入编译 hash；作者显式字号、字重和颜色仍优先。

登录后向项目应用的 `dashboard-candidates` 入口提交候选请求，使用返回的 candidateId 下载 `dashboard-candidates/:candidateId/standalone-executable`，接收方直接运行 EXE。请求字段以 `dashboardPublicationCandidateRoutes.ts` 为准；窗口验证会启动本机播放器。旧 `portable-zip` 与 `offline-archive` 下载保留。

当前窗口证据覆盖入口页实际 draw；作者 sampleData、已保存数据集和管道已进入冻结闭包。KPI/表格服务端布局、direct/semantic 数据源、跨宿主外观和交互仍未全部接通；能力报告保留 blocked/degraded。该入口不代表 C1～C5 完整验收。
