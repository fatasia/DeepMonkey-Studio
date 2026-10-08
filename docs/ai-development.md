# 用 Codex、Claude Code 开发三维应用

Deep Engine 可以像普通 TypeScript 三维库一样嵌入自己的网页。Skill 帮 AI 选择模板、使用真实 API 并检查画面；MCP 让 AI 连接正在运行的 Studio，读取场景和执行编辑事务。

| 你要做什么 | 使用入口 |
| --- | --- |
| 从空项目做三维应用 | [Deep Engine SDK](../apps/web/src/docs/deep-engine-sdk.md) + [八个模板](../templates/deep-engine-3d/README.md) |
| 让 Codex 写场景代码 | [deep-engine-3d Skill](../.agents/skills/deep-engine-3d/SKILL.md) |
| 让 Claude Code 写场景代码 | [同一 Skill 的 Claude 分发](../.claude/skills/deep-engine-3d/SKILL.md) |
| 读取和修改 Studio 中打开的场景 | 本文的 MCP 接入步骤 |
| 扩展脚本、HTTP API 和插件 | [SDK/API 总览](../apps/web/src/docs/sdk-api-overview.md)、[SDK 示例](../apps/web/src/docs/sdk-examples.md)、[插件开发](plugin-runtime-foundation.md) |

## 1. 让 AI 使用 Skill

克隆仓库，在仓库根目录启动 Codex 或 Claude Code。两份 Skill 已随源码交付，无需额外安装。直接输入：

```text
# Codex
$deep-engine-3d 用 02-factory-floor 模板做一个三维车间，加入设备状态灯和相机环绕。
使用 SDK 的真实导出，运行类型检查和浏览器验证，给我渲染后的截图。

# Claude Code
/deep-engine-3d 用 02-factory-floor 模板做一个三维车间，加入设备状态灯和相机环绕。
```

在自己的项目中使用时，从源码目录运行：

```sh
node templates/deep-engine-3d/scripts/distribute-skill.mjs --root /absolute/path/to/my-project
```

该命令同时写入目标项目的 `.agents/skills/deep-engine-3d/` 与 `.claude/skills/deep-engine-3d/`，保留其他配置；同名内容冲突时停止。还需把 `templates/deep-engine-3d/` 复制到目标项目的同一路径，保留共享文件和 `references/`。重新打开客户端会话后调用 Skill。[Codex Skill 目录规则](https://developers.openai.com/codex/skills)、[Claude Code Skill 规则](https://code.claude.com/docs/en/skills)。

## 2. 安装 SDK，开始写代码

环境为 Node.js 24、pnpm 11.18.0；浏览器渲染需要支持 WebGPU 的浏览器及 HTTPS 或 localhost。

SDK 通过 [GitHub Releases](https://github.com/fatasia/DeepMonkey-Studio/releases) 中的 `DeepMonkey-Studio-SDK-<版本>.tar.gz` 分发，包内有正式 JS、TypeScript 声明、依赖归档和八个模板。安装步骤见 [SDK 离线安装](sdk-release.md)。当前 `@bim-studio/*` 包为仓库私有包，使用发布的 `.tgz` 或源码构建，不直接从 npm registry 安装。

从源码生成同样的 SDK 包：

```sh
pnpm install --frozen-lockfile
pnpm --filter @bim-studio/contracts build
pnpm --filter @bim-studio/scene-sdk build
pnpm --filter @bim-studio/server-sdk build
pnpm --filter @bim-studio/deep-engine build
node scripts/export-release-sdk.mjs
```

模板从 [01-starter](../templates/deep-engine-3d/templates/01-starter/scene.ts) 开始：`scene.ts` 定义几何、材质、实例、相机和动画，`browser.ts` 接入浏览器，`node.ts` 检查场景逻辑。共享 [harness.ts](../templates/deep-engine-3d/harness.ts) 展示完整的创建、渲染、读回与释放流程：

```ts
import { DeepApp, PbrRendererPlugin } from "@bim-studio/deep-engine/app";
import type { RenderPacket } from "@bim-studio/deep-engine";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";

export async function renderScene(
  canvas: HTMLCanvasElement, packet: RenderPacket, view: RenderView,
) {
  if (!navigator.gpu) throw new Error("当前浏览器不支持 WebGPU");
  const app = await DeepApp.create({
    state: null,
    plugins: [new PbrRendererPlugin({ canvas, gpu: navigator.gpu, packet, view: () => view })],
  });
  await app.advance(0);
  return app; // 页面卸载或替换场景时 await app.dispose()
}
```

宿主负责帧循环；动画更新实例矩阵，复用几何和纹理。API 签名与材质参数见 [API 速查](../.agents/skills/deep-engine-3d/references/api-surface.md)和[材质速查](../.agents/skills/deep-engine-3d/references/material-parameters.md)。仓内运行 `pnpm gate:hc7p2-templates` 可验证八模板的类型、Node 逻辑和真实浏览器画面。

## 3. 连接 Studio MCP

先按 [启动教程](../README.md)或 [Docker 部署](docker-application.md)启动完整 Studio。MCP 地址是 `http://127.0.0.1:4100/api/mcp`，随 API 服务运行；GitHub Pages 静态体验站不提供这个服务。

MCP 使用 Studio 登录会话的 Bearer token。下面以 PowerShell 为例，在启动 AI 客户端的同一终端登录，密码不会写入命令历史：

```powershell
$studioCredential = Get-Credential -Message '输入 Studio 用户名和密码'
$studioLoginBody = @{
  username = $studioCredential.UserName
  password = $studioCredential.GetNetworkCredential().Password
} | ConvertTo-Json
$studioLogin = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4100/api/auth/login' -ContentType 'application/json' -Body $studioLoginBody
$env:DEEPMONKEY_TOKEN = $studioLogin.token
Remove-Variable studioLoginBody, studioLogin, studioCredential
```

macOS/Linux 可调用同一个登录 API，再通过 `export DEEPMONKEY_TOKEN='登录响应中的 token'` 设置环境变量。普通会话有效期 12 小时，服务重启后需重新登录；不要把 token 写入仓库。

**Codex**：

```sh
codex mcp add deepmonkey --url http://127.0.0.1:4100/api/mcp --bearer-token-env-var DEEPMONKEY_TOKEN
codex mcp list
codex
```

桌面客户端也可配置同一 HTTP 地址和 Bearer 环境变量；需确保客户端进程能读取该变量。只在终端设置变量不会修改已经运行的桌面进程。

**Claude Code**：在项目 `.mcp.json` 的 `mcpServers` 中合并以下配置，再从设置过环境变量的终端启动 `claude`：

```json
{
  "mcpServers": {
    "deepmonkey": {
      "type": "http",
      "url": "http://127.0.0.1:4100/api/mcp",
      "headers": { "Authorization": "Bearer ${DEEPMONKEY_TOKEN}" }
    }
  }
}
```

在 Claude Code 中用 `/mcp` 查看连接状态。HTTP 配置与环境变量展开见 [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)。已有配置请合并，不要覆盖其他服务。

## 4. 第一次调用

在浏览器登录同一个 Studio 账号，打开目标场景，保持编辑器在线。然后让 AI：

> 列出 deepmonkey 的工具和资源，读取当前编辑器场景与诊断；说明有哪些模型及其状态。使用资源中的真实 ID，不猜项目、会话或对象 ID。

再尝试修改：

> 把选中设备沿 X 轴移动 1 米。先读取当前场景修订号，再用 editor.scene-transaction 提交事务，检查回执并重新读取位置。

工具以 `tools/list` 返回的名称和 JSON Schema 为准。场景资源通过 `resources/list` 和 `resources/read` 读取；编辑事务由在线浏览器执行，一次最多 64 条命令，修订冲突应重新读取后处理。保存项目、发布交付是独立操作。

| 现象 | 检查 |
| --- | --- |
| 401 / 连接未授权 | token 是否过期，AI 客户端是否继承 `DEEPMONKEY_TOKEN` |
| 工具可见，资源为空 | 是否使用同一账号打开了有权限的场景，编辑器是否在线 |
| 写事务 unavailable / timeout | 目标编辑器会话是否仍在线，是否选中了正确 sessionId |
| rejected / revision conflict | 查看回执，重新读取 revision 与对象 ID；不要重复提交旧事务 |
| Pages 地址连接失败 | 改用本机或已部署的完整 Studio API 地址 |

协议实现见 [MCP 路由](../apps/api/src/mcpCapabilityAdapter.ts)、[编辑事务桥](../apps/api/src/mcpEditorSceneTransactionBridge.ts)；扩展工具时沿用 [能力契约](../packages/plugin-runtime/src/capability.ts)和既有权限、超时、取消机制。
