# GitHub Wiki 镜像说明

应用内文档中心（`apps/web/src/docs`，32 篇）是唯一文档事实源。GitHub Wiki 只是它的生成镜像，**禁止在 Wiki 上直接编辑内容**，否则会在下次导出时被覆盖。

## 生成

```bash
pnpm docs:wiki:check    # 校验文档源内链与配图一致性
pnpm docs:wiki:export   # 导出到 artifacts/wiki/
```

`artifacts/wiki/` 产物：

- `Home.md`：文档首页，按 docsCatalog 六个分组列出全部文章（生成物，勿手改）。
- `<文章 id>.md`：32 篇正文，`/docs/<id>` 内链已改写为 `<id>.md`，`/docs-assets/` 配图已改写为相对路径并随包复制到 `docs-assets/`。
- `_Sidebar.md`：GitHub Wiki 每页侧边导航（分组同 Home）。
- `.sync-manifest.json`：每篇文章的源路径与 SHA-256，用于核对镜像与源一致。

导出前 `--check` 必须通过；`pnpm test` 中的 `scripts/sync-docs-wiki.test.mjs` 会再次验证链接改写、配图打包与 Home/_Sidebar 完整性。

## 发布到 GitHub Wiki

截至 2026-09-24，`https://github.com/fatasia/bim-studio.wiki.git` 尚不存在（`git ls-remote` 返回 Repository not found）。GitHub Wiki 需要在仓库 Settings → Features → Wikis 开启并至少通过网页创建一次任意页面后，git 远端才可用。开启后执行：

```bash
pnpm docs:wiki:export
git clone https://github.com/fatasia/bim-studio.wiki.git artifacts/wiki-repo
# 清空 clone 中的旧 .md（保留 .git），再把 artifacts/wiki 的产物复制进去
cp artifacts/wiki/*.md artifacts/wiki/.sync-manifest.json artifacts/wiki-repo/
cp -r artifacts/wiki/docs-assets artifacts/wiki-repo/
cd artifacts/wiki-repo && git add -A && git commit -m "docs(wiki): sync in-app documentation mirror" && git push
```

推送后用 `git -C artifacts/wiki-repo status` 确认干净；如源文章有增删，重复 `export → copy → push` 即可。Wiki 不承载独立内容，仓库内 `docs/` 的产品文档（capabilities、部署、格式支持等）不进 Wiki 镜像，保持文档中心与仓库文档的既有分工。
