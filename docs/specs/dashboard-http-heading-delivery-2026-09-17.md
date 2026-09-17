# 带标题图表的 HTTP 离线交付验收

已将 `verify-dashboard-published-portable.mts` 接到真实 localhost HTTP：创建草稿→编辑→发布→公开版本读取→重开磁盘存储→候选→ZIP/DMDA/单 EXE 下载。标题使用 `330a021` 的正式采集链；本片只修改验收脚本，没有修改候选注册或生产存储。

## 实现

- 新增 `--chart-heading`，保留 `--sample-chart` 和原图形模式。发布原先直接调用 store、下载原先使用 `app.inject`，现在全部经过实际 HTTP 路由。
- `DASHBOARD_HEADING_FONT_MANIFEST` 显式选择已有本地 OFL 字体记录，regular/bold 字节写入隔离对象存储，SHA、许可证与已发布 revision 共同进入现有 fontCatalog。
- ZIP 验证解包哈希、运行包一致性及真实 Native 三帧；DMDA 走正式 `runDashboardOfflineNative`，保留原启动参数，在真实呈现检查点之后受控终止。
- 单 EXE 无参数运行，目录中只有该 EXE，PATH 仅包含 Windows System32；呈现后核对恢复检查点与完整运行包字节。ZIP 内容不包含 JS/MJS/CJS/HTML 应用。

## 真实证据

最终目录：`test-output/dashboard-http-heading-20260917-r4/`。

| 项目 | 结果 |
|---|---|
| HTTP 编辑/发布版本 | revision 2；公开读取、落盘重开后的 publication 完全一致 |
| 图表数据 | 作者样本 A=37、B=91，ChartIR 数据逐值核对 |
| 标题/单位 | `Authored output` / `MW`，两张非空图集，Native 日志 `atlases=2` |
| GPU | RTX 4060 Laptop，Vulkan，1200×800，3 帧，GPU errors clean |
| ZIP | 5,736,817 bytes；`ce109166d95a7c43d290a7d878a598df22b73f394c7fe460a03e0d66275a91bc` |
| 单 EXE | 15,150,352 bytes；`ee55ac8926dd1e3686d4f04e7fb5bb0427951e98c098c7aef617d975e9d1b463` |
| 运行包 | `87a8a5282b62532072ee7aa60c3151e13a9c45df3693e6666ccf1c778331a59b` |

复用当前静态 CRT Release：`test-output/native-chrome-delivery-20260917-r2/deep-engine-native-0.1.0-x86_64-pc-windows-msvc/bin/deep-engine-native.exe`，SHA-256 `a729bdee2f8f9782af5302098a17301f691c72844b2284450eef5b0d13032e45`，未重建 Native。

`evidence.json`、`downloaded-open.json`、`standalone-validation/evidence.json` 与两个 `player.log` 分别保存候选、ZIP/DMDA 实际打开、无参数 EXE 证据。字体来源沿用本地 `dashboard-layout-ofl-20260916/fonts.json` 的 Adobe Source Sans 3/OFL-1.1 记录与冻结 SHA；字体字节、EXE 和测试存储不提交仓库。

4 项脚本测试、7 项 API 候选/fontCatalog 回归、严格脚本 typecheck 和 repository gate 通过。`--sample-chart` 旧路径真实 HTTP 回归通过，未启用标题时仍保留 title/unit deferred。非法可执行文件查询返回 400；删除候选后三种下载均返回 404。

复跑：先 `node scripts/build-dashboard-content-compiler.mjs`，设置字体 manifest 的绝对路径，再运行：

```text
pnpm exec tsx --conditions=development scripts/verify-dashboard-published-portable.mts <native.exe> <device-sha256> <不存在的输出目录> --chart-heading
pnpm exec tsc -p scripts/tsconfig.dashboard-acceptance.json
pnpm exec tsx --conditions=development --test scripts/lib/dashboardAcceptanceHttp.test.mts scripts/lib/dashboardPublishedHeadingFixture.test.mts
```

## 边界

本次是独立磁盘测试项目，未连接用户 postgres/minio。登录认证不在门禁内；候选接口使用显式 fixture editor 身份。DMDA 是待导入的数据归档，其导入宿主不是单 EXE；最终单 EXE 与 ZIP 播放器均未获得浏览器/Node 运行依赖。

字体覆盖仅验证 Source Sans 3 英文 regular/bold。完整图表外观、中文字体、跨宿主整帧像素一致性、交互与任意客户工程未由本片证明；`appearance.crossHost` 等字段保持 degraded/deferred。未改 UI，本片不新增视觉评分；标题两轮视觉复检见[前一片记录](dashboard-chart-heading-capture-2026-09-17.md)。

工程十维自评均为 9：复用正式路由/编译器/归档/播放器，测试覆盖真实呈现、身份一致性、失败返回、许可缺失与旧入口回归；证据范围与未验项如上。
