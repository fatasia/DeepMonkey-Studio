# 开发与贡献

文档修正、故障复现、测试和代码都属于贡献。先选一个可以独立验证的问题，再提交范围清晰的 Pull Request。

## 找到合适的入口

先搜索已有 Issue 与 Pull Request。小型修复和文档更正可直接提交；公共 API、数据迁移、新依赖或架构调整先写明问题、方案与兼容影响。仓库[贡献指南](https://github.com/fatasia/bim-studio/blob/HEAD/CONTRIBUTING.md)是完整要求。

UI 在 `apps/web`，API 与存储在 `apps/api`，桌面集成在 `apps/desktop`。共享合同位于 `packages/contracts`；文档正文在 `apps/web/src/docs`，解析与搜索位于 `packages/docs-runtime`。

Deep Engine 与 Native 的实现分别位于 `packages/deep-engine` 和 `packages/deep-engine-native`。涉及引擎时先核对支持范围和测试证据，避免将实验能力写入稳定承诺。

## 建立开发环境

按[安装与首次启动](/docs/getting-started)启动 Web。从自己的 Fork 创建分支，完成一个可复现的改动；保留锁文件，不提交本地环境配置与生成产物。

运行最接近改动的测试后，在请求合并前执行仓库要求的完整检查：

```bash
pnpm gate:repository
pnpm typecheck
pnpm test
pnpm build
```

页面、GPU、数据、资源与发布链有额外专项门禁。准确记录命令、结果和未执行的项目，检查范围以根目录 `package.json` 与贡献指南为准。

## 修改产品文档

一篇文档解决一个用户任务，按“前提 → 操作 → 预期结果 → 排障 → 下一步”组织。按钮名称使用当前产品文案，代码示例来自实际 API；尚未支持的能力写清适用范围。

页面正文随应用离线分发，并作为 GitHub Wiki 镜像的唯一来源。内部链接使用 `/docs/文档ID#章节`，示意图放在 `apps/web/public/docs-assets`；Wiki 导出会把图片复制到同名相对目录，保证镜像不依赖可变分支 URL。新增文章需在 `docsCatalog.ts` 注册分类与顺序，并更新目录测试；改文后运行 `pnpm docs:wiki:check`，发布文档时运行 `pnpm docs:wiki:export`。

操作截图只放脱敏、可公开的稳定图片到 `docs-assets`，不得把 `test-output`、客户模型、令牌、私人地址或临时登录画面嵌入文章。截图的来源、生成提交和对应验证命令写在文章或发布证据里；测试运行截图仍留在本地证据目录，文档以文字链接描述证据位置，不将临时产物复制成产品文档图片。

```bash
pnpm --filter @bim-studio/web test src/docs/docsCatalog.test.ts src/components/DocsCenter.test.tsx
```

本地文档渲染器支持标题、段落、平铺列表、引用、代码块、链接和图片。复杂表格、嵌套列表和内嵌 HTML 应改为简单段落或步骤，并在实际页面检查渲染。

## 准备可审查的改动

Pull Request 说明问题、结果、验证、文档和许可影响。用户可见变化同时更新 `CHANGELOG.md` 的 `Unreleased`。界面修改附双主题和相关窗口尺寸的截图；数据变更附保存、刷新恢复和失败路径证据。

提交第三方代码、模型、字体或图片时记录来源、版本、许可证与修改情况。贡献者应有权提交，并按根目录许可证发布贡献；不额外虚构签署流程。政策见[社区与支持](/docs/community)。
