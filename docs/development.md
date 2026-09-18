# 开发者上手

本指南帮助第一次贡献代码的人找到模块、启动开发服务并验证改动。先读[贡献指南](../CONTRIBUTING.md)，详细服务配置见[原生部署](native-deployment.md)。

## 从 Fork 开始

在仓库页面创建自己的 Fork，克隆后新建功能分支。进入仓库根目录，使用 Node.js 24 和根目录 `packageManager` 固定的 pnpm 版本：

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm studio start web
pnpm studio check
```

新环境按 `.env.example` 配置；已有 `.env` 时保留原内容。不要为了修复启动错误切换已有数据库或对象存储。Web 开发无需构建 Windows 客户端，格式转换、AI 与现场协议服务按具体任务准备。

## 找到要改的模块

| 路径 | 负责内容 | 先检查什么 |
| --- | --- | --- |
| `apps/web/src` | 页面、编辑器、客户端状态和浏览器渲染 | 相邻组件、控制器和对应测试 |
| `apps/api/src` | 路由、鉴权、业务服务与存储 | 路由注册、权限与数据合同 |
| `apps/desktop` | Tauri 客户端与打包 | 平台要求和构建说明 |
| `packages/contracts` | 共享类型和数据合同 | 调用方、版本兼容与迁移 |
| `packages/docs-runtime` | 文档解析、目录、链接与搜索 | 解析和链接回归测试 |
| `packages/deep-engine` | WebGPU 内核与测试 Lab | 支持边界与真实 GPU 证据 |
| `packages/deep-engine-native` | Rust / wgpu 执行器 | 工具链、合同和目标平台测试 |
| `tools` | Revit、Unity 等集成 | 外部软件依赖与再分发范围 |

## 开发时验证

先跑与改动相关的单测，例如文档目录：

```bash
pnpm --filter @bim-studio/web test src/docs/docsCatalog.test.ts
pnpm --filter @bim-studio/web typecheck
pnpm gate:repository
```

API 或共享合同改动还要验证实际调用方。涉及数据时验证保存、刷新恢复和失败重试；页面改动验证实际点击、窄屏与双主题。提交前按贡献指南运行完整检查，并在 PR 里写出结果。

## 写文档

应用内文章位于 `apps/web/src/docs`，入口为 `/docs`；部署与工程资料位于 `docs`。新增页面需要注册 `docsCatalog.ts`，配图放在 `apps/web/public/docs-assets`，并更新导航、搜索与链接测试。

每页围绕一个任务写前提、步骤、结果和故障处理。示例使用真实接口；不要把内部排期、单次测试结果或开发机路径写成产品承诺。维护规则见[文档写作规范](documentation.md)。
