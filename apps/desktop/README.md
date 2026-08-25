# Dev Studio Desktop

M7 的 Tauri 2 薄宿主。它打包 `apps/web` 的同一份静态产物，只负责桌面系统边界，不复制编辑器业务逻辑。

当前基础切片提供：

- 本地静态前端，不加载远程页面；
- 单一可变服务器配置，校验 HTTP(S) 地址并持久化到应用配置目录；
- 仅向主窗口开放三条服务器配置命令；
- 无 shell、任意文件系统或远程页面 Tauri 权限。

尚未宣称完成：安全持久令牌、系统浏览器 OAuth 回调、本地工作区/恢复点、断点上传、转换 sidecar、签名、自动更新和安装包验收。这些必须继续通过 M7 门禁后才能标记完成。

```powershell
pnpm install
pnpm --filter @bim-studio/desktop build
pnpm --filter @bim-studio/desktop dev
```

`dev` 会启动同一套 `@bim-studio/web` Vite 前端；`bundle` 会先生产构建 Web，再生成桌面包。
