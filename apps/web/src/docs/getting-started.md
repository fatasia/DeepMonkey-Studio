# 安装与首次启动

Deep Monkey Studio 是可以自托管的三维与数据可视化平台。这篇文档带你从源码启动 Web 和 API，建出第一个场景并保存、预览。文档随应用一起提供，离线也能打开。

## 准备环境

只体验 Web 版需要 Git、Node.js 24 和 pnpm 11.18.0。pnpm 的版本以仓库根目录 `package.json` 里的 `packageManager` 为准，依赖按锁文件安装。需要从源码构建 Windows 桌面客户端时，再额外准备 Rust、C++ Build Tools 和 WebView2。

第一次安装依赖要联网，或者有可用的依赖镜像。计划离线使用的话，请在断网前备好模型、字体和所需服务；外部 AI、在线视频和远程数据源本身仍然依赖各自的服务。

## 获取并启动源码

```bash
git clone https://github.com/fatasia/DeepMonkey-Studio.git
cd DeepMonkey-Studio
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm studio start web
```

没有 `corepack` 命令时，先安装 Corepack 再继续。已有部署配置的话保留原来的 `.env`；第一次自建环境请参照仓库里的 `.env.example`，完整参数见[部署与系统运维](/docs/deployment-operations)。

默认的 Web 地址是 `http://localhost:5173`，API 地址是 `http://localhost:4100`，以启动器实际输出为准。端口被占用时可以换端口，例如 `pnpm studio start web --web-port 5174 --api-port 4101`。启动后在 Windows 和 macOS 上会自动打开浏览器；不想自动打开就加 `--no-open`（Linux 默认不打开）。

本机开发环境的管理员账号和密码都是 `admin`。这只适用于本机体验，对外提供服务前必须更换。

## 确认服务可用

```bash
pnpm studio status
pnpm studio check
```

`status` 显示进程和地址；`check` 检查已经在运行的服务，不健康时以非零退出码结束，适合放进脚本。检查失败时先处理输出里最早出现的那个依赖，不要重复启动占用同一端口的进程。

浏览器打开 Web 后应该能进入“项目工作台”，API 的健康检查地址是 `/health`。页面能打开但项目列表加载失败，多半是 API 地址、代理或登录状态的问题。

## 做出第一个场景

1. 在项目工作台左上角确认当前项目。还没有项目时点“新建第一个项目”。
2. 在“项目场景”点“新建场景”，输入名称。“初始内容”建议保持默认的“示例本体（推荐）”：它会放入底座、立柱和一个行为热点，点击热点会聚焦并弹出提示，进入画布就能看到效果。想从零搭建就选“空白场景”。点“创建并进入”。
3. 进入编辑器后，用顶部的“二维 / 三维”切换工作区。三维里可以选中示例对象调整位置和外观，也可以直接删除，示例对象名称里都带“示例”两个字。二维里添加指标、图表或文字组件。
4. 点“保存项目”；顶部的“自动保存”开着时，修改会自动写入。
5. 返回“项目场景”，点场景卡上的“预览”，确认文字、组件和交互符合预期；再重新打开场景，确认保存的内容都在。

如果只是想先看看成品，可以到“示例场景”页，用“智造园区综合案例”之类的内置案例点“创建可编辑案例”，得到一份可以随意修改的副本。

第一次体验不需要接入现场设备、配置 AI 或安装专业格式转换器。完整的编辑方法见[从项目到首个可发布场景](/docs/dashboard-scene)。

## 接下来读什么

按下面的顺序读，基本就是一条从零到交付的路线：

1. [项目、资源与发布版本](/docs/core-concepts)：先弄清项目、资源、实例和发布版本的关系。
2. [管理资源并插入 2D / 3D](/docs/resource-workflow)和[模型导入与格式选择](/docs/model-import)：把自己的模型放进来。
3. [连接数据、处理逻辑并发布接口](/docs/data-pipeline)：让场景用上真实数据。
4. [预览、体检与发布](/docs/server-publish)：交付给别人看。
5. [交付自检与故障恢复](/docs/troubleshooting)：遇到问题时的排查顺序。

## 停止与继续工作

`pnpm studio restart` 按上次的启动参数重启，`pnpm studio stop` 关闭由启动器管理的进程。停止前先保存编辑内容；重新打开后如果出现恢复提示，先看清楚再选择，见[恢复未保存修改](/docs/troubleshooting#恢复未保存修改)。

启动失败时先读[故障恢复](/docs/troubleshooting)，想参与开发读[开发与贡献](/docs/contributing)。