# npm / Cargo 安装

Node.js 24+ 可直接启动编辑器，浏览器 SDK 需要 WebGPU 与 HTTPS / localhost。Rust 只在开发或安装原生播放器时需要。

| 目标 | 命令 |
| --- | --- |
| 完整 Studio Web 编辑器 + API | `npx deepmonkey` 或 `npx deepmonkey-studio` |
| 已有项目安装三维 SDK | `npm i deepmonkey` |
| 创建带模板与 Skill 的三维应用 | `npx create-deepmonkey my-world` |
| 安装 Rust 原生播放器 | `cargo install deepmonkey-native --version 0.2.0 --locked` |
| 安装离线几何工具 | `cargo install deepmonkey-geometry --version 0.1.0 --locked` |
| Rust 项目安装独立 Deep2D | `cargo add deepmonkey-2d` |

## Studio

首次启动下载 GitHub Release 的运行包，核对大小与 SHA-256。Windows x64 包已包含服务端依赖，解压即可启动；其他平台首次安装锁定的依赖。后续启动使用缓存。账号 `admin`，密码保存在终端提示的 `standalone-credentials.json` 的 `adminPassword` 字段。

```sh
npx deepmonkey --port 4200 --data-dir ./studio-data --no-open
npx deepmonkey --prepare-only
```

`--data-dir` 设置项目数据；`--cache-dir` 设置运行包缓存；`--no-open` 只启动服务；`--prepare-only` 只下载、安装。默认使用当前用户的 `DeepMonkeyStudio` 目录，数据与运行版本分开保存。退出用 Ctrl+C。

这是本地 Web/API 部署；AI Provider、外部数据源与云渲染仍需配置对应服务。Windows 包含预编译的 Deep Native 播放器与 LibreDWG；其他平台的原生目标需按能力配置。Windows 桌面窗口、Android 和签名发布使用对应 Release 或源码构建链。

SDK npm 压缩包约 3.1 MB，脚手架约 3.3 MB；启动器约 16 KB。完整 Studio 的 Windows x64 运行包约 287 MB，包含 Web、API、原生播放器与依赖；其他平台使用约 156 MB 的基础包，再安装服务端依赖。

## SDK 与 Skill

```sh
npx create-deepmonkey my-world --template 06-logistics
```

默认安装并启动预览；`--no-start` 只创建和安装，`--no-install` 只生成文件，`--no-open` 不打开浏览器。八模板可从 `01-starter` 到 `08-structure` 选择。编辑 `scene.ts`；`npm run dev` 启动、`npm run build` 检查类型并生成静态站点。

生成项目已包含 `.agents/skills/deep-engine-3d` 与 `.claude/skills/deep-engine-3d`。在项目目录启动 Codex / Claude，调用 `$deep-engine-3d` / `/deep-engine-3d`。通过 MCP 编辑 Studio 的步骤见 [AI 开发](ai-development.md)。

## Rust

要求 Rust 1.93+ 与平台编译工具。Windows 需 Visual Studio C++ Build Tools，Linux 需原生窗口、音频等依赖的开发环境。

```sh
deepmonkey-native --help
deepmonkey-native --package runtime-package.json
deepmonkey-geometry build model.obj model.dgc
deepmonkey-geometry verify model.dgc
```

原生播放器读取 Studio 导出的运行包及其资源；它不启动 Studio API。作为 Rust 库安装：

```sh
cargo add deepmonkey-native@0.2.0
```

几何库使用别名保留原有模块名：

```toml
geometry_dag = { package = "deepmonkey-geometry", version = "0.1.0" }
```

Deep2D 是独立二维库，不依赖三维引擎。默认提供 `wgpu` 绘制；只做布局、路径准备与 CPU 光栅化可用 `cargo add deepmonkey-2d --no-default-features`。宿主负责窗口、事件循环和字体图集，接口与示例见 [Deep2D](../packages/deep2d/README.md)。
