# H-C6-S3-connect 首批:externalResource / scriptGit 两"部分"入口接通(2026-10-02,子智能体)

> 任务:把 inventory v1(`hc6s3-inventory-v1-20261002.md`)点名的两个"部分"业务域
> (外部资源 externalResourceApi / 脚本 Git scriptGitTypes)升为"接通"——用户能从产品 UI
> 真实到达既有后端能力;后端已就绪部分零改动;不碰 contracts 公共类型。
> 浏览器证据:`test-output/hc6s3-connect-20261002/`(1280×1080 深色,report.json failures=0)。

## 1. 现状核查(六步)

1. **inventory v1**:两行"部分"= externalResourceApi(client 在、入口待点名)、scriptGitTypes(types only、消费面待点名)。
2. **grep 实证(关键发现,inventory 判定滞后)**:
   - scriptGit:后端 `scriptGitRoutes.ts` 七端点在 `api/index.ts:253` 注册;前端 `api.ts:334-355` 七个 client 函数齐全;**UI 消费方早已存在**——`ScriptVersionManager.tsx`(状态/历史/提交/远端配置/移除/拉取 diff 确认/推送,全量消费七端点)由 `SceneBehaviorPanel.tsx:435` 挂载,入口在 `BehaviorPanelHeader.tsx:96`「更多工具 → 脚本版本」。inventory 的 grep 用小写 `scriptGit` 匹配不到 `ScriptGit*` 类型名,属大小写漏检,非真实缺口。
   - externalResource:`externalResourceApi.ts` 两个函数的 UI 消费方也已在——①仪表盘地图组件 `DashboardInspectorData.tsx`(GeoJSON URL 输入)→ `DashboardWidgetVisualization.tsx:386` `api.getExternalJson`;②参数化工作台 `ParametricModelWorkbench.tsx:117` `api.downloadExternalModel`(AI 生成的模型 URL → 下载 → 上传为资源)。
3. **估时表**:`remaining-tasks-estimates-20260930.md` H-C6-S3-connect 行(8-20h,低信心);接线范本 `e4-ui-wiring-20261002.md`(最小装配纪律)。
4. **测试与证据**:ScriptVersionManager.test.tsx(5)/ScriptDependencyManager.test.tsx(7)/api scriptGit 族(10)全绿在库;**真实缺口=入口级验证**:externalResource 地图外部资源加载零测试,失败路径静默伪装(见 §3),parametric 下载链零测试。
5. **bim-studio/AGENTS.md**:不存在;工作区约束按 `D:\Documents\bim\AGENTS.md`。
6. **根账本** `jc-i-continuation-20261001.md` 只读;:568 四路并行,本路=①。

**结论**:两域 UI 入口均已存在(不重建);真实缺口是"入口真实浏览器路径未验证 + externalResource 消费面存在断根级缺陷"。本批=验证接线 + 修实测抓出的缺陷 + 补入口级测试。

## 2. scriptGit 域:真实浏览器路径验证(零后端/零 UI 改动)

浏览器全链(隔离实例:独立端口/独立数据目录,`isolatedStudioGate`):

```
登录 → 建项目/场景 → Studio → 工具坞「仿真与开发」→「行为脚本」
→ 脚本列表「新建」→「保存脚本」→ header「更多工具 ⋯」→「脚本版本」
→ 状态区(main/脚本仓库正常)→ 填修改说明 →「提交快照」(真打 POST /script-git/commits)
→ 200 + committed + commit.shortHash → 提交历史出现该条目 → Esc 关闭回到面板
```

断言:dark-theme ✓ / 面板开启 ✓ / 入口可见 ✓ / git 状态加载 ✓ / commit-api-ok 200 ✓ / commit-created(hash 如 2021037)✓ / history-visible ✓ / 关闭无残留 ✓ / 控制台 0 错误 ✓。

截图:01(studio 入口前)、02(行为面板,入口可见)、03(脚本版本对话框)、04(提交成功+历史)、05(关闭后面板,动线无扰动)、diag-develop-menu(工具坞菜单结构)。

本地桌面模式降级(`unavailableReason`)与 SSR 边界由 §4 测试覆盖;**拉取/推送/远端配置**需外部 Git 远端,本批未在浏览器实测(见 §6 边界),组件逻辑由既有测试与 `scriptGitRoutes.test.ts`(本地 bare 仓库 push/pull 全链)覆盖。

## 3. externalResource 域:实测抓出断根缺陷并根因修复

### 3.1 缺陷链(仪表盘地图组件,三处同机制)

浏览器实测(dev 源 + `?__visualQa=dashboard` 通道,组件库「地图」→ 数据页签 → GeoJSON URL):

| # | 缺陷 | 机理(文件:行为) | 级别 |
|---|---|---|---|
| D1 | **整页崩溃**:填入可访问的外部 GeoJSON URL,页面坠入错误边界(STUDIO_RENDER_FAILED) | `DashboardWidgetVisualization.tsx` registerMap 异步导入未完成时,主流程同步 `setOption({series:[{type:"map"}]})` → ECharts `Map not exists` → `MapSeries.getInitialData` 读 `undefined.regions` 抛错(探针实录堆栈) | P0 |
| D2 | **失败伪装加载中**:URL 失联时永远显示"GeoJSON 加载中…" | `.catch(() => setGeoJson(undefined))` 吞错;且图表大 effect 依赖数组缺失败态,失败后不重渲染 | P1 |
| D3 | **占位从未渲染**:"加载中/请配置"占位文本从不显示(画布空白) | 占位用 ECharts `title` 组件,但 `echarts.use([...])` 从未注册 `TitleComponent`,ECharts 静默丢弃 | P2 |

D1/D2/D3 同机制(地图外部资源渲染链)一次清剿;inventory"部分"的真因即此:该路径此前**从未真正可用**。

### 3.2 修复(`apps/web/src/components/DashboardWidgetVisualization.tsx` + 新模型叶)

1. **新叶 `dashboardMapResourceModel.ts`**:`resolveDashboardMapGeoJsonState`(empty/loading/error/ready 四态互斥;失败禁止退回 loading)+ `dashboardMapGeoJsonPlaceholderMessage`(双语,失败文案带可操作动作"请检查地址或网络后重试")。
2. **D2**:catch 落 `geoJsonFailed` 态;URL 变更即重置旧图与失败态(旧图残留会掩盖新地址的失败);非对象 JSON(null/数组/标量)按失败处理;`geoJsonFailed` 补入图表 effect 依赖数组。
3. **D1**:地图 series 应用整体收进 `applyMapSeries`;未注册时主流程**停在占位**,`import("echarts/core")` 完成 `registerMap` 后再应用(带 `chartRef.current === chart && !chart.isDisposed()` 守卫);模块加载失败走 console.error 不静默。
4. **D3**:`echarts.use` 补 `components.TitleComponent`(注释注明占位依赖)。
5. `DashboardWidgetRuntime.tsx` 穿线 `locale` 给 `DashboardDrillChart`(原占位文案为硬编码中文,违反 i18n 纪律,一并改 `tr()` 双语)。

后端零改动、contracts 零改动、主线程禁区(behavior/*、ai/* 等)零接触。

### 3.3 修复后浏览器三态证据(深色 1280×1080)

| 截图 | 状态 | 断言 |
|---|---|---|
| 06-map-widget-empty-state.png | 未配置 | 画布居中「请配置 GeoJSON」 |
| 07-map-geojson-error-state.png | 失败地址(路由 abort) | 「GeoJSON 加载失败;请检查地址或网络后重试」,**不再伪装加载中** |
| 08-map-geojson-ready-state.png | 有效地址(路由满足 FeatureCollection) | 多边形区域渲染 + visualMap 图例,页面存活 |

崩溃回归探针:修复前变体 A(加地图→直接填有效地址)= CRASHED(日志含 `Map not exists`/`regions` TypeError/`STUDIO_RENDER_FAILED`);修复后同变体 = ALIVE 且地图渲染(探针脚本已删,结论录本档)。

**改动前缺陷态截图未留档(诚实声明)**:迭代中截图被后续轮次覆盖;缺陷机理以探针崩溃日志 + §3.1 代码级根因为证,修复后三态与单测为回归门禁。

### 3.4 externalResource 第二消费方(点名,未改动)

参数化工作台 AI 生成链 `Modeling3dPanel onImport → api.downloadExternalModel(url) → api.uploadModel`(ParametricRoutePage / SceneManagerDialogs 挂载,既有"模型优化"域入口到达)。客户端合同由 §4 新测试锁定;浏览器端到端依赖外部 AI 服务,未实测(§6)。

## 4. 测试(新增 8 例,全绿)

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `apiClients/externalResourceApi.test.ts`(新) | 4 | 协议/凭据白名单前置拒绝(ftp/内嵌凭据/javascript: 相对地址按服务器档案解析;HTTP 503 → 人话错误带状态码;credentials omit + accept 头 + AbortSignal 超时;Blob 下载) |
| `components/dashboardMapResourceModel.test.ts`(新) | 2 | 四态互斥映射;失败文案带动作、双语、不含"加载中" |
| `components/ScriptVersionManager.test.tsx`(追加) | 2 | 无 projectId 边界("请先保存项目",不出提交/远端表单);注入 client 的加载帧(role=status,不出提交表单) |

**回归**:web tsc `--noEmit` 0;web 组件族 ScriptVersionManager 7 + ScriptDependencyManager 7 + ParametricModelWorkbench 4 + DashboardWidgetRuntime 15 + WorkspaceUiRegression + SceneBehaviorPanel 9 = **50/50 绿**;api scriptGit/scriptDependency 族 **10/10 绿**(既有断言逐字保持,后端零改动)。`npm run build` 通过(首屏 301.9 KiB/gzip 96.9 KiB,预算内)。

## 5. 交付物清单

| 文件 | 变更 |
|---|---|
| `apps/web/src/components/dashboardMapResourceModel.ts` | 新增(四态模型+双语占位) |
| `apps/web/src/components/dashboardMapResourceModel.test.ts` | 新增 |
| `apps/web/src/apiClients/externalResourceApi.test.ts` | 新增 |
| `apps/web/src/components/DashboardWidgetVisualization.tsx` | D1/D2/D3 根因修复 + locale 穿线 + i18n |
| `apps/web/src/components/DashboardWidgetRuntime.tsx` | +1 行(locale 透传) |
| `apps/web/src/components/ScriptVersionManager.test.tsx` | +2 边界例 |
| `apps/web/scripts/hc6s3-connect-batch1-browser.mjs` | 新增(浏览器证据脚本,可复跑) |
| `test-output/hc6s3-connect-20261002/` | 9 截图 + report.json(本档 §2/§3.3) |
| `apps/web/dist/` | 重建(含修复,供 gate 复跑) |

## 6. 边界(诚实声明)

- **inventory v1 未回写**:两行"部分"→"接通"的修订属主线程账本,本档即修订依据,不越权改 `hc6s3-inventory-v1-20261002.md`。
- **scriptGit 拉取/推送/远端配置未做浏览器实测**:需可用的外部 Git 远端(公司 Git/局域网 bare 仓库);既有 `scriptGitService.test.ts` 以本地 bare 仓库覆盖该链(10/10),浏览器级留待有真实远端的验收环境。
- **parametric downloadExternalModel 链未做浏览器实测**:依赖外部 AI 生成服务;客户端合同已由新测试锁定。
- **改动前缺陷态截图未留档**(§3.3 声明);修复后三态 + 崩溃探针前后对照(CRASHED→ALIVE)为等效证据链。
- **发布链(DashboardStaticRoot)地图路径未实测**:本批修复同源(同一组件),受益但未单独验证。
- 地图注册的微任务级竞态(同 chart 连续换 URL)沿用既有 last-write-wins 语义,未扩scope。
- 未 commit/push;帧时/GPU 未测(禁测项)。

## 7. 结论

- **脚本 Git 域:接通(存量 UI 验证)**——inventory"部分"为 grep 漏检,真实浏览器路径 8 断言全绿,写链(commit→history)实测入库。
- **外部资源域:接通(修复后)**——地图外部 GeoJSON 路径从"首用即崩"修复为三态完备(未配置/失败/就绪),加载失败不再伪装加载中;客户端安全边界(协议/凭据/超时)测试锁定。
- 建议主线程据此把 inventory 两行升级为"接通(生产)",并在 connect 批量重估时剔除这两项。
