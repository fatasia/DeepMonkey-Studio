# Native desktop publication acceptance — 2026-09-25

本次验收覆盖真实 Tauri Windows 产物、包内本地 API sidecar，以及 Native/Android 发布资源闭包。没有用单元测试代替打包验收。

## 已执行

```powershell
pnpm desktop:bundle
pnpm --filter @bim-studio/desktop verify:bundle
pnpm --filter @bim-studio/desktop test
pnpm --filter @bim-studio/desktop smoke:local-publication
```

`desktop:bundle` 完整执行了 API build/deploy、Native Windows job host 编译、Web production build、Tauri release 编译和 NSIS/MSI 链接。API sidecar 部署包含 507 个生产包，并清理了 11,262 个开发文件。

## 结果

- `verify:bundle`：通过。`frontendDist` 使用本地 `web/dist`，WebView2 使用 `offlineInstaller`，资源清单和文件时间新鲜度均通过。
- Desktop Rust tests：**10 passed, 0 failed**；主程序和 doc tests 也通过。
- `smoke:local-publication`：通过。真实启动包内 `node.exe + dist/index.js`，检查 `auth=200`、Native candidate 路由 `400`、Dashboard candidate 路由 `400`、Three executable 路由 `200`，并下载后执行发布 viewer 的 `--inspect-scene-viewer-payload`，包身份和 SHA-256 均匹配。
- 资源闭包：sidecar 10,081 个文件；Native executable 20,682,240 bytes；Android template APK 23,487,046 bytes。
- 安装包：NSIS 445,583,376 bytes；MSI 512,549,735 bytes。两个产物均由本轮 Web dist 重新生成，`verify:bundle` 通过。

## 限制

本机没有在管理员权限的干净 Windows 虚拟机执行真实安装、覆盖升级和卸载门禁；该门禁仍按 `apps/desktop/README.md` 的 `verify-windows-install-lifecycle.ps1` 流程执行。当前已完成构建、包体、资源闭包、sidecar 启动和发布路由验收。
