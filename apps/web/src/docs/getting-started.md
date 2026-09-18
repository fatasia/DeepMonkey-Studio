# 安装与首次启动

Deep Monkey Studio 面向需要自托管模型、设备数据和可视化应用的团队。本指南从源码启动 Web 与 API，再完成一个可保存、可预览的场景；文档随应用提供，打开后无需访问外部文档站。

## 准备环境

Web 开发需要 Git、Node.js 24 和 pnpm 11.18.0。以仓库根目录的 `packageManager` 为准安装 pnpm，使用锁文件安装依赖。Windows 桌面源码构建还需要 Rust、C++ Build Tools 和 WebView2；只体验 Web 时无需准备这些工具。

首次安装依赖需要联网或可用的依赖镜像。离线使用前应准备模型、字体、运行时与所需服务；外部 AI、在线视频和远程数据连接仍取决于各自服务。

## 获取并启动源码

```bash
git clone https://github.com/fatasia/bim-studio.git
cd bim-studio
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm studio start web
```

没有 `corepack` 命令时，先安装 Corepack，再执行上述步骤。已有部署配置时保留原 `.env`；首次自建环境按仓库环境模板配置服务，完整参数见[部署与系统运维](/docs/deployment-operations)。

默认 Web 地址为 `http://localhost:5173`，API 地址为 `http://localhost:4100`；以启动器实际输出为准。当前开发环境的管理员账号和密码均为 `admin`。

## 确认服务可用

```bash
pnpm studio status
pnpm studio check
```

`status` 显示进程和地址，`check` 检查已经运行的服务并通过退出码报告失败。检查失败时先处理输出中最早失败的依赖，不要重复启动占用相同端口的进程。

浏览器打开 Web 后应能进入项目工作台；API 健康入口为 `/health`。Web 能打开但项目列表请求失败时，检查 API 地址、代理配置和登录状态。

## 完成第一个场景

1. 选择项目，点击“新建场景”，输入名称并进入编辑器。
2. 添加一个二维组件，修改标题与显示内容；有可用 GLB 模型时再加入三维场景实例。
3. 保存后打开预览，确认文字、组件和交互符合预期。
4. 回到项目场景页重新打开，确认保存内容已恢复。
5. 需要交付时完成发布体检，再打开发布链接验证。

完整操作见[从项目到首个可发布场景](/docs/dashboard-scene)。首次体验不需要接入现场设备、配置 AI 或安装专业格式转换器。

## 停止与继续工作

`pnpm studio restart` 按上次启动参数重启；`pnpm studio stop` 关闭启动器管理的进程。停止前保存编辑内容，重新打开后先检查本地草稿提示。

启动失败先读[故障恢复](/docs/troubleshooting)，理解项目与发布关系读[核心概念](/docs/core-concepts)，参与开发读[开发与贡献](/docs/contributing)。
