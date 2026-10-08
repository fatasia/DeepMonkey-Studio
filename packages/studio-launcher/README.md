# deepmonkey-studio

Start the complete DeepMonkey Studio Web editor and API on your computer.

**一条命令启动 DeepMonkey Studio 三维编辑器。** 提供场景编辑、资源管理、数据与 AI 服务入口，项目保存到本机。

[Online demo](https://fatasia.github.io/DeepMonkey-Studio/) · [GitHub](https://github.com/fatasia/DeepMonkey-Studio) · [Installation guide](https://github.com/fatasia/DeepMonkey-Studio/blob/main/docs/registry-install.md)

![Studio editor](https://raw.githubusercontent.com/fatasia/DeepMonkey-Studio/main/docs/assets/engine-switch-menu.png)

```sh
npx deepmonkey-studio
```

Requires Node.js 24+. The first run installs verified runtime components through your configured npm registry, including npm mirrors. Windows x64 includes server dependencies; other platforms install them on first launch. Later runs reuse the cache. Project data stays in your local DeepMonkeyStudio data directory across version upgrades.

Use `--port 4200`, `--data-dir ./my-studio-data` or `--no-open` as needed. The administrator account is `admin`; the terminal shows the location of its generated password. AI providers and remote render workers use the same configuration as a normal Studio deployment.

```sh
npx deepmonkey-studio --port 4200 --data-dir ./my-studio-data
```

Read `adminPassword` in the printed `standalone-credentials.json` file to sign in. `--prepare-only` downloads and prepares the runtime; `--cache-dir` selects its cache. Ctrl+C stops the server.

The Web/API runtime is about 111 MB. Windows x64 adds about 151 MB of native tools and dependencies. Each component is cached separately. Studio installation no longer requires a GitHub Releases download.

## Use AI or build an application

Connect Codex or Claude Code to Studio's authenticated `/api/mcp` endpoint to read and edit the open scene. [Skill / MCP setup](https://github.com/fatasia/DeepMonkey-Studio/blob/main/docs/ai-development.md).

For independent application development, install [deepmonkey](https://www.npmjs.com/package/deepmonkey) with `npm i deepmonkey`, or start from `npx create-deepmonkey my-world`. `npx deepmonkey` starts the same Studio runtime as this package.

[Windows downloads](https://github.com/fatasia/DeepMonkey-Studio/releases/tag/v0.2.0) · [Docker](https://github.com/fatasia/DeepMonkey-Studio/blob/main/docs/docker-application.md) · [Issues](https://github.com/fatasia/DeepMonkey-Studio/issues)

See the included license files for project terms and third-party notices.
