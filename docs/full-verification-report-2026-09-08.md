# 2026-09-08/09 夜间全量验证报告（素材·行业包·已知问题修复）

任务来源：用户定时指令（2026-09-08 23:10 触发）。四条线：推进素材线、推进行业包线、修复六项已知问题、整体全量验证（输出本报告）。执行窗口 23:10 起持续作业。

**基线状态**：起跑于 `fa501fd`（最终统一验收后，工作树干净），Web 438 文件/1827 项、API 132 文件/597 项全绿。本批结束于 `03f5c27` 及其后的报告/审核批次提交。

## 一、本次推进完成的事项清单

### 1. 六项已知问题修复（用户实测反馈，已全部修复并获浏览器证据）

| # | 用户反馈 | 根因 | 修复 | 验证 |
|---|---|---|---|---|
| 1 | 脚本编辑器分屏拖动时 3D 编辑器闪 | `animate()` 先用旧缓冲渲染、后执行 ResizeObserver 排定的 `setSize`——清空的画布被本帧 paint（`viewerEngineRuntime.ts`） | 渲染前先调用 `this.resize()`（尺寸未变早退），"清缓冲+重绘"落在同一 rAF | 已知问题门禁：连续 resize 期间 screencast 采样无空白帧 |
| 2 | 编辑器菜单栏"更多"点击无反应 | `.topbar-actions` 自带 `overflow-y:hidden`，弹层被垂直裁剪为不可见；旧补丁只在 ≤1500px 断点生效，>1500px 视口复发 | 顶栏动作区改 `overflow:visible`，删除按断点打的补丁（`scene-workspace.css` / `studioWorkspacePolish.css`） | 1920 宽点开"更多"弹层可见且 `elementFromPoint` 命中菜单内 |
| 3 | 云渲染不可用/发布中不可点击/设置不会用 | 三层：`/api/admin/cloud-render` 对非 admin 403 被吞成"未配置"；云渲染卡片整体禁用导致用户永远看不到原因；设置页只有 env 模板无步骤 | 新增登录可读 `GET /api/cloud-render/capability`（server-sdk 合同 `CloudRenderCapability`）；卡片保持可选中+下方可见原因行+发布按钮禁用；设置页渲染缺失项 checklist 与三步启用引导（启动 worker→写 env 并重启→测试后到场景管理开启）；管理中心弹窗同享 cloudHint | API 契约测试（viewer 可读/未配置清单/无敏感字段）+ 弹窗提示行截图证据 |
| 4 | 视觉/智能运营等页面 tab 栏高度不够 | `.vision-tabs button` 35px 声明长期被 `accessibilityReadability.css` 的 `.app-workspace-frame` 28px 兜底**以更高特异性压制**（35px 从未实际生效） | 二级页主 tab 40px、面板级 32px，显式 `!important` 提级；同族清剿 pipeline-debug 26px、dashboard-inspector 27px、operations-source 30px、inspector-context 30px（`centers.css` 等 5 个样式文件） | 门禁实测 vision/operations tab ≥40px |
| 5 | 二维资源缩略图全都是一样的 | `BuiltInAssetBrowser.tsx` 误读 `preset.widget.type`（预设工厂从不写该字段，恒为 undefined），`?? "value"` 静默兜底——157 个预设全部渲染成指标卡 | 改用顶层 `preset.type`；合同收窄 `widget: Partial<Omit<DashboardDataWidgetConfig,"type">>` 使此类错误变成编译错误 | 回归测试：首页每张卡 `data-preview-variant` 互不相同、图形语义 >3 种 |
| 6 | optimizer 页面很多问题 | 一族问题：6-9px 字号未纳入 12px 可读性基线；流水线"转换"步骤对直读 GLB 也标完成；保存禁用原因单一；无拖放；切原始/优化重建渲染器丢相机；死规则；awaiting-model 导入中闪现空壳选项 | 字号全面提级（控件 12px/说明 11px/点击目标 ≥28px）+ accessibilityReadability 兜底；流水线三态 done/active/skip/pending（直读显示"免"不再冒充完成）；保存禁用按 无结果/参数过期/处理中 三分提示；空态拖放导入 + drag-over 高亮；预览切视图保留相机位姿；删死规则；awaiting-model 收紧为无源即收起；载入失败文案 i18n | gate-optimizer-workflow 4/4：实测全部 fontSize=12、对比度深色 5.53/浅色 4.56 起、29 worker 全关、全流水线+发布+匿名通过 |

顺手修复：`scripts/*.test.mjs`（node:test 门禁脚本）被 vitest 误收集导致全量测试 1 个假失败——`vite.config.ts` 增加 test.exclude 收集口径修正，全量转绿（交接文档遗留建议项）。

提交：`eb0cb34`（编辑器 UX 批次）、`2d654e1`（云渲染批次）、`03f5c27`（电力包）。

### 2. 素材线推进（四批视觉审核，批准 7→32）

- 复用既有审核管线（`gate-source-b-review-batch.mjs` 采集 → 人工逐项三视角亲审 → `apply-source-b-visual-review.mjs` 校验应用），四批共 **48 个模型**完成真实浏览器双主题两轮×三视角采集（每批 48/48 组、采集阶段零渲染异常）：
  - 批次 2（`source-b-review-93D4Ut`）：审核 12，**批准 7**（橙弯管外的蝶阀双把手、冷却塔、红砖厂房、锥齿轮机构、A319、BS4825 蝶阀、废弃仓库）
  - 批次 3（`source-b-review-GQP6j5`）：审核 12，**批准 6**（换气风机、机械臂、蝶阀 MxM、直行辊筒段、蒸汽锅炉、蝶阀焊接接口）
  - 批次 4（`source-b-review-J6Tc4U`）：审核 12，**批准 5**（接线箱、运动摩托车、打蛋器、叉装车、辊筒段直行）
  - 批次 5（`source-b-review-G62MMB`）：审核 12，**批准 7**（减速机构 II、法兰球阀、锅炉房角景、恒温阀、三速齿轮、配电箱、航空仪表）
- 素材库可用资产 **7 → 32**（累计审核 63/166，剩余 103 项待审，批次 6 采集已完成待亲审）。
- 审核决定逐项留档：`docs/source-b-visual-review-batch{2,3,4,5}-2026-09-08.json`（含逐项理由、缩略图 hash、署名许可核对）。

### 3. 行业包线推进（2 包 10 页 → 3 包 15 页）

- 新增**电力能源运行包**（`industryPackPowerGrid.ts` + 样本 + 测试）：能源总览→能耗与成本→供配电运行→告警处置→资产健康环形工作流，变电站级联筛选跨页联动；独立业务故事（2#站变压器重载+告警未结、3#站光伏消纳波动）；总览计数与运行/告警/资产台账逐项对账锁定在单测，求和列取整数避免浮点显示歧义。
- `gate-power-grid-pack.mjs`（新写）两轮双主题 4/4：导入/撤销重做/样本校验拒绝与修正/保存刷新/跨页联动/CSV 列与站值/发布→匿名动作链（48 tce→10 MW→1 条逐页断言）/匿名明细行数。
- 电力包 gate 截图亲审：KPI 与筛选站联动正确、图表/明细/导出按钮正常。

## 二、全量验证范围与结果

| 验证轴 | 命令/工具 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck`（全仓 21 工作区） | ✅ 通过 |
| 源文件体量 | `check-source-size.mjs` | ✅ 2199 个源文件全部 ≤800 行 |
| Web 单测 | `vitest run`（apps/web） | ✅ 431 文件 / 1806 项全过（含本批新增电力包 4 项、缩略图回归 1 项、云渲染契约 2 项） |
| API 单测 | `vitest run`（apps/api） | ✅ 599 项全过（597 基线 + 2 项 capability 契约） |
| 其余包 | contracts 245 / desktop 5 / industrial-agent-orchestrator 16 / jt-reader 4 / ppr-lite 10 / docs-runtime 5 等 | ✅ 全过 |
| 生产构建 | `pnpm --filter @bim-studio/web build` | ✅ 通过；首屏 314.6 KiB / gzip 103.7 KiB，预算（1855.5/527.3）内 |
| 六项修复门禁 | `gate-known-issues-fixes.mjs`（新写，隔离环境） | ✅ 7/7：更多菜单 1920、双页 tab 高度、缩略图多样性、optimizer 字号/拖放、云渲染可见原因+禁用、resize 无空白帧；页面错误 0 |
| 电力包门禁 | `gate-power-grid-pack.mjs`（新写，隔离环境） | ✅ 4/4（暗/亮 × 1440/980） |
| 优化器工作流门禁 | `gate-optimizer-workflow.mjs` | ✅ 4/4：完整优化-保存-取消-恢复-发布-匿名链路；29 worker 全关 |
| 性能基准 | `gate-viewer-performance-audit.mjs`（生产构建 QA 夹具，本机 headless Chrome，1440×900 DPR1） | ✅ 120 对象 WebGL 55.8fps/WebGPU 57.5fps；1000 对象双后端 60.0fps；4 组 0 错误；qaReady 583–911ms；over50ms 帧 ≤0.67%（诊断基线口径，非 Unity 对标或万级承压承诺） |
| 全路由巡检 | `u117-full-sweep.mjs`（正常 5173 栈，admin） | ✅ 10 条路由（manager/data/vision/operations/optimizer/docs/system/3D 编辑器/只读/发布）无横向溢出、交互按钮正常；见下方诚实声明 1 条 |
| 大型模型 | `test-model/` 97MB IFC 等夹具经既有转换/优化门禁覆盖（optimizer-workflow 内含真实转换与优化保存全链） | ✅ 通过（既有夹具口径，未新增超大客户模型） |

证据目录：`test-output/codex-2026-09-05/{known-issues-fixes-UWUtj9, power-grid-pack-vHA6oD, optimizer-workflow-zZWSEK, viewer-performance-3kj3GR, source-b-review-*}`、`apps/web/test-output/nightly-2026-09-08/`（u117 全路由截图）。

## 三、发现缺陷及严重级别

**本批修复（P1×2 / P2×4 / P3×5）**：见第一节表格。同族排查记录：tab 高度问题根因是特异性压制，同族清剿了全部 5 处低于 32px 的面板 tab；缩略图根因是合同双入口，同族修正为编译期禁令；云渲染 403 误判同族清剿了编辑器弹窗与管理中心两处入口。

**发现并如实保留、未在本批处理**：

| 级别 | 事项 |
|---|---|
| P3 | u117 巡检序列下 `/published` 记录 1 条控制台错误；单独复访同页 8 秒采样 0 错误，判定为巡检序列状态残留类偶发，未定位到可修根因，保留观察 |
| P3 | 白模素材一族（球阀、闸阀、锅炉、舵机、支架、液压缸、长输送机等 ≥7 项）保持待审：需要材质增强管线或明确降级用途，不能靠"几何存在"放行 |
| P3 | 品牌/商标风险素材 3 项待审：Shell 涂装加油机、蝙蝠侠标志、表盘含第三方品牌文字的压力表——CC 许可不等于商标授权，按品牌红线不进入公共包 |
| P3 | `dashboard-inspector-tabs` 等面板 tab 高度已提至 32px，但其 7-10px 字号只提到 10px，未达 12px 业务基线（画布内用户作品不适用基线，此处为面板 chrome，留待后续统一） |
| 观察项 | 首屏 JS 304.8 → 314.6 KiB（本批仅少量增量，主要来自前批 html-to-image 等引入，未做预算外回退） |
| 观察项 | 素材库"轻量/已校验"徽章密度与 12px 卡片排版（既有待办）未在本批改动 |

## 四、未验证/未覆盖部分（诚实声明）

1. **素材剩余 103 项未视觉审核**（166 总量中已审 63）。批次 6 已采集完成、待亲审；审核结论必须逐项人工目视，不做批量自动放行。
2. **云渲染端到端会话未验证**：本机无独立 GPU Worker 进程与 Chromium 编码环境，capability=未配置路径已验证，"配置后建会话→WebRTC 媒体证据→观看端"链路沿用既有 `cloudRenderPublicationLifecycle` 测试与合同，未在真实 GPU Worker 上复验。
3. **分屏拖动闪烁的机制等价验证**：门禁用连续 viewport resize 触发同一 resize→渲染链路并采样 screencast 帧，未在真实指针拖拽分隔条下逐帧采证；机制相同但非同一交互路径，建议人工复验一次。
4. **性能口径限制**：性能基准为固定夹具（120/1000 图元）本地 headless Chrome 诊断基线，不代表客户级大模型、目标 GPU 矩阵或长时间稳态；8 小时长稳与移动端在明确排除清单内。
5. **u117 未覆盖四级钻取动线**（园区→建筑→楼层→设备）之类的深度场景编排，仅遍历平台路由与关键交互入口。
6. 本报告不将上述局部通过外推为"全项目完成"；项目级后验收（真实客户模型/数据/GPU/网络矩阵）仍按总账保留。

## 五、功能深度不足与交互体验改善建议（后续排期输入)

1. **云渲染一键可用**：`pnpm studio start web` 不启动 GPU Worker；建议增加 `studio start --cloud-worker` 目标（注入必填 env + Chrome 路径探测），把"三步引导"压缩为一步。
2. **白模素材提质管线**：为待审白模族提供材质增强（程序化 PBR 预设）或独立衍生转换通道，而不是长期挂起。
3. **集合包拆分工具**：PSX 集合、机床车间集合类资产需要拆分为单件素材再入库。
4. **审核吞吐**：每批 12 项 × 双轮采集约 8 分钟，亲审为人工瓶颈；可考虑先用聚类预筛（同作者/同系列抽 1 详审）提高覆盖率，但放行仍逐项确认。
5. **面板 chrome 字号统一**：dashboard-inspector 等遗留 10px 面板字号并入 accessibilityReadability 基线收口。

## 六、结论

- 六项用户已知问题全部修复，每项都有"根因定位 → 聚焦测试 → 浏览器证据（断言+截图）"闭环，不是表面补丁。
- 素材库可用资产 7→32（+25，全部带真实渲染缩略图、许可署名与逐项理由），行业包 2→3（新增 5 页电力能源包，端到端门禁 4/4）。
- 全量验证基线全绿：typecheck、2199 源文件体量、Web 1806 项、API 599 项、其余包 285 项、生产构建、六个浏览器门禁、性能基准、全路由巡检。
- 未验证与未覆盖部分如上第五节前第四节的六项声明，不以此批通过冒充全项目完成。
