---
name: deep-engine-3d
description: 用 Deep Engine Web SDK(@bim-studio/deep-engine)从需求生成可运行 3D 工业场景:从 8 个领域模板起步,Node/浏览器双门运行,读真实渲染证据后局部修改。当用户要求"做一个 3D 场景/数字孪生/工业可视化 demo"或要在空项目里快速得到可运行三维画面时使用。Use when the user asks to create, run, or modify a 3D scene with the Deep Engine standalone Web SDK.
---

# Deep Engine 3D 模板工作流

一个内核入口:`DeepApp` + `PbrRendererPlugin`,消费 `RenderPacket`(geometries/materials/instances)。所有名称均为 SDK 真实导出(版本见 `references/sdk-versions.json`,示例导出已在发布门核对过 dist 声明)。

## 1. 选模板

| 模板 | 什么时候用 |
|---|---|
| 01-starter 通用基础场景 | 从零起步、验证安装与渲染链路 |
| 02-factory-floor 工厂车间 | 产线设备阵列、通道标线、雾效纵深 |
| 03-equipment-monitor 设备监控 | 状态三色灯、告警呼吸、屏幕面板、选中高亮 |
| 04-robot-cell 机器人单元 | 多关节机械臂层级运动、围栏 |
| 05-pipeline 管线输送 | 管廊走向、透明观察段、介质流动 |
| 06-logistics 物流仓储 | 货架巷道、AGV 往返、输送辊道 |
| 07-energy 能源站 | 储罐、变配电、警示信标 |
| 08-structure 结构框架 | 梁柱楼层、玻璃幕墙、构件高亮 |

细节与 showcase 见 `references/templates.json`。

## 2. 起步:复制模板到空项目

模板在仓内 `templates/deep-engine-3d/templates/<id>/`;复制单个模板目录时**必须同时携带** `sceneTypes.ts`、`harness.ts`、`nodeHarness.ts`、`tsconfig.node.base.json`、`tsconfig.browser.base.json`(清单:`references/templates.json` 的 `sharedFiles`)。依赖用精确版本安装(不要用 `^`/`~`):

```json
{ "dependencies": {
  "@bim-studio/deep-engine": "0.2.0",
  "@webgpu/types": "0.1.72" } }
```

版本必须与 `references/sdk-versions.json` 一致;升级流程见该文件 `upgradeDetection`。

`@bim-studio/*` 当前通过 GitHub Releases 的 SDK 归档分发，不从 npm registry 安装。下载 `DeepMonkey-Studio-SDK-0.2.0.tar.gz`，按包内 `INSTALL.md` 安装本地 `.tgz` 与依赖归档；仓内构建和打包见 `docs/sdk-release.md`。上面的版本表用于校验包身份，不是 registry 安装命令。连接 Studio MCP 的客户端配置见 `docs/ai-development.md`。

## 3. 运行与观察

仓内一键门(构建 SDK → 打包 → 仓外空项目安装 → 逐模板 tsc + Node 断言 + esbuild + Chrome WebGPU 像素证据 + 截图):

```bash
pnpm gate:hc7p2-templates
# 等价:pnpm --filter @bim-studio/deep-engine build && node templates/deep-engine-3d/scripts/gate-templates.mjs
```

证据落在 `test-output/hc7p2-templates-20261002/`:每模板 `*-rendered.png`(渲染态截图)、`*-browser.png`、`report.json`。单模板快速迭代:在消费者项目里 `tsc -p templates/<id>/tsconfig.json && node out/node/templates/<id>/node.js`(Node 无头断言动画/结构),浏览器侧看 `*-rendered.png`。命令明细见 `references/run-commands.md`。

## 4. 局部修改

只改目标模板的 `scene.ts`:几何尺寸在 `geometries`,颜色/粗糙度/自发光在 `materials`(参数速查:`references/material-parameters.md`),布局与动画在 `instances`/`update()`/`eye()`。改完重跑该模板的 Node 门与浏览器门,对比新旧截图确认只影响目标对象。API 签名与约束见 `references/api-surface.md`;不要调用文档之外"看起来应该存在"的函数——以 dist `.d.ts` 为准。

## 5. 释放与收尾

`app.dispose()` 幂等(返回同一 Promise);取消用 `AbortSignal` 传入 `PbrRendererPlugin`。浏览器门协议自动验证 cancelled/disposed;自建长驻应用在停止 RAF 循环后必须 `await dispose()`。
