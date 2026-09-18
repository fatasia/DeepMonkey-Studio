# GLM 交接：主流程全线收拢与下一步（2026-09-18）

> 版本：2026-09-18（GLM 主线会话收尾）
> 适用目录：D:/Documents/bim/bim-studio
> 上游交接：[codex-mainline-handoff-2026-09-17.md](codex-mainline-handoff-2026-09-17.md)（权威顺序不变，本文件是增量状态与接续入口）
> 口径：只计已提交证据；每条都有独立提交号；并行会话已停摆（最后活动 09-17 14:35），本会话已全面接管其三条 lane。

## 0. 一页现状（截至本提交）

| 主线 | 状态 | 关键证据 |
|---|---|---|
| 阶段 1 Web 静态包 | **100%** | loader 竞态修复 b3b6bc3；生成端+消费端整组 a3fd714；两轮浏览器 15/15 be879a7；API `web-package` 下载格式 9da690e；G04 测量链全线 d91913d/618b6d3/72b52f5 |
| 阶段 2 Deep2D | **P0 全绿 / P1 主体 / P2 收口 / P3 4+1** | 收官评估 [deep2d-mainline-closure-2026-09-18.md](specs/deep2d-mainline-closure-2026-09-18.md)；D1 缺陷已修 7b8d84b（17 步全链全绿） |
| 阶段 3 Deep Engine | scene Native 链已收拢入库 | api 链 2c03003/81d3db7；web scene 客户端链 dae7ad2；packages/scripts 9aa965c；docs f1943fa |
| 阶段 4 工业格式 | S0 补齐；3DM 平面重建在途成果已入库 8438de7 | 样本 12+1 条、RSS 五方向、缺口盘点见 [industrial-s0-evidence-inventory](specs/industrial-s0-evidence-inventory-2026-09-17.md) |
| DE26 | A 组基座启动 | A02/A03 资产+轨迹+采样合同 1fe776a（A01 历史已完成） |

本会话累计 **100+ 独立提交**，全部"实现+测试+证据+报告"完整切片。三大基线全绿：web 3589 / api 1218+ / native lib 362-363 + bin 126-129。

## 1. 权威入口（不变，按序读）

1. AGENTS.md、bim-studio/AGENTS.md、D:/Documents/bim/AGENTS.md（含工业格式硬门槛）
2. specs/industrial-3d-format-work-plan-2026-09-16.md
3. codex-mainline-handoff-2026-09-17.md（固定顺序）+ 本文（增量）
4. active-task-recovery-ledger.md（**已全量更新至本会话末**，含全部提交号）
5. specs/deep2d-remaining-tasks-2026-09-16.md（任务表已同步实际状态）
6. specs/deep2d-mainline-closure-2026-09-18.md（Deep2D 收官评估+遗留清单）

## 2. 本会话关键交付（按域，全部已提交）

### Web 静态包（阶段 1 完结）
- b3b6bc3 loader EOF 取消竞态+包根纵深防御；a3fd714 生成器+静态入口整组入库
- be879a7 r6 端到端重生成后两轮浏览器 15/15（根/子目录/双主题/980 窄屏/全屏/篡改/缺资源/取消恢复）
- 9da690e API 第四下载格式 `web-package`：合同下沉 contracts（`dashboardFrozenFontStyle` 单一实现）、api 生成器模块 186 行、路由接线，三包测试全绿
- 遗留：部署层 webStatic 真实接线（部署配置工作非代码缺口）

### Deep2D 主线
- **P0 八项全绿**：P0-04 放行门禁 7e8c60c（prepare+下载双边界）；P0-06 五组件中文全链 ebd51dd + 三缺陷根因修复（标题 letterbox scissor 2cb395d / 测量满框 72b52f5 / 轴图例 9f804f8）；P0-07 身份 golden 8296c7c；P0-08 矩阵 2a89a37+色差关闭 f780844（读回 alpha 反预乘，GPU 管线本就一致，全格 SSIM≥0.9899）
- **P1**：23 项盘点=17 完成+决策/接线类（[盘点结论在台账]）；本会话收官 P1-03 分块接线 72eefb0、P1-09 Bloom 按需 2f15181（16 SHA 等价）、P1-12 交叉关闭 47c1c84、P1-13 HTTP+泵 0ab976e/9146d7f、P1-16 UIA 桥 467a8f4（真实窗口 6 节点枚举）、P1-18 字形合同 5732f23+筛选文字端到端 f0801cc、P1-23 N1 TS 消费 97f58ed（四类 digest 黄金对拍）、P1-01 resize da71239、P1-19 关闭（OFL 允许内嵌，cosmic-text 树内已有 bidi+swash → P1-20 改为零新依赖接线）
- **P2**：P2-01 收口 dbddfb3（lpac 4 项失败实证为动态 CRT 构建问题，静态重编 4/4）；P2-02 双认证 f4e8ebb；P2-03 宿主轨迹 1f467d1；认证报告 v2 d6fd29a
- **P3**：P3-01 delta 合同 492992e（16 项测试，watch 接线待接）；P3-02 双端预览 604dee1；P3-03 HMAC 扩展 61937e4；P3-04 设备矩阵 5b60594（Vulkan/DX12 位级一致）；P3-05 升级回滚 17 步 ad6ca44 + **D1 缺陷修复 7b8d84b**（根因：恢复分支不挂 pending_lkg → 呈现信号与检查点永不提交；修复后 17 步全绿 defects 空）

### Deep Engine scene 链（接管并行会话在途工作并收拢）
- 2c03003/81d3db7 api：nativeSceneCandidate 四件套（service/compiler/registry/routes）+ 窗口验证器 + scenePublication 依赖捕获/存储/路由 + sceneDiscard + publicAssetKey + cloudRender 并发/身份 + routes/config/objects 接线
- dae7ad2 web：sceneClient 包链 12 模块（package/index/manifest/prepared/dependencies/resources/applications）+ compileSceneCamera/RenderPacket/RuntimePackage + sceneSnapshotRenderPacket + StudioDeep WebGPU 会话族（bridge/grid/shadow/environment/fog/overlay）+ 兼容性 gate + UI 组件
- 9aa965c packages/scripts：studio-core sceneClient 四模块 + contracts formatImport/scenePublicationCompatibility + sceneClientArchive 脚本族 + native-scene compiler/verifier worker + Unity bridge smoke
- f1943fa/aa34e71 docs+配置：deep-engine 文档族、平台就绪、desktop 无边框配置、治理白名单
- **注意**：EXE 验收口径漂移——03:18→HEAD 的 native 渲染演进使 `exe-v2 atlases=3→16` 断言失配（A/B 对照证实为渲染演进非缺陷），需要该演进线同步验收口径（见 test-output/p03-05-d1-fix-20260918/atlas-check）

### 工业线（接管收拢）
- 8438de7 3DM 平面重建与边界审计 fixture 族（7 测试过）；S0 样本库 13 条（data/ 不入库）+ RSS 五方向（test-output/industrial-s0-rss-20260918/）
- S0 缺口矩阵见 industrial-s0-evidence-inventory-2026-09-17.md：3D Tiles/SolidWorks 离线阻断记录在案、JT 版本矩阵缺、七方向无完整体积/RSS 记录（laz-perf 除外）

### DE26（用户已排序：在全量深度测试前）
- 就绪盘点 [de26-readiness-inventory-2026-09-18.md]（19 项起点+依赖顺序+删除项防线）
- A02/A03 已交付 1fe776a：3 真实资产（bim 烘焙 176k 面/预热机远原点/电池爆炸动画）+ 轨迹合同（orbit-360/select-clip）+ 采样合同八通道（CPU/GPU timestamp/present/input/上传/RSS 分开，对齐 chart_e2e_perf 分位）；资产不可再分发仅本机基准

## 3. 立即可做的下一批（按优先级）

1. **DE26 A04/A08**：成对基准 runner（复用 1fe776a 的采样器+轨迹；Three/Babylon 适配器已有 babylonAdapter 在途文件）→ 自动证据与差距报告。对标只有 Three.js/Babylon.js/Unity。
2. **delta watch 接线**（P3-01 尾巴）：`app/package_watch.rs` 热路径 manifest 嗅探 + LKG 基线取回 → `apply_runtime_package_delta(lkg_bytes, manifest)` 一调接入 + GPU 呈现证据。
3. **工业 S1/S2**：统一 SourceBundle 任务/质量合同（S1 门槛）；3DM 共边 49 条清剿继续（fixture 族已就位）。
4. **EXE 验收口径同步**：atlases=3→16 断言与渲染演进对齐（小片）。
5. **全量深度测试**（用户指定最终项）：Deep Engine / Deep2D / 模型格式 × 性能+显示效果；大量基线可直接复用（chart_e2e_perf 七场景、P0-08 矩阵、S0 RSS、DE26 采样合同）。
6. P2-03 真实系统 IME、Narrator 真人朗读、断网物理干净机（人工步骤，用户执行）。

## 4. 环境与红线提醒（不变+新增）

- 全部旧红线继续有效：不写 XT 只写 X_T；不把商业 SDK/云转换当依赖或 blocker；不用 git add .；不 push；不删 unknown/blocked；不降误差预算。
- **LPAC 测试必须静态 CRT**：`RUSTFLAGS=-C target-feature=+crt-static`，examples 需同旗标重建（陈旧动态 CRT example 会 0xc0000022，是构建问题非环境限制）。
- GPU 读回测试挂 **--bin** 不是 --lib；capture 目录环境变量 DEEP_DASHBOARD_CAPTURE_DIR；rgba 用 sharp 转 PNG。
- deep-engine source-size gate 当前有 34 个既有超限文件（并行演进产物），新增文件需自律 ≤300 行（新实测门禁 800 行/文件，以 check-source-size.mjs 为准）。
- web 静态包/多组件验收脚本输入样例在 test-output/dashboard-http-multicomponent-20260917/ 与 dashboard-multicomponent-fonts-20260917/（字体清单）。
- 基线命令组（交接第 7 节）继续有效；公共 Web 改动合流时补生产构建与浏览器门禁。

## 5. 台账与报告索引

全部本会话条目已在 active-task-recovery-ledger.md 逐条记录（含提交号）。关键 spec 报告（2026-09-17/18）：
web-static-package-browser-verification / dashboard-measured-layout-compiler-input / dashboard-capability-publication-gate / dashboard-identity-golden / dashboard-pixel-matrix-native-readback / deep2d-title-letterbox-fix / chart-axes-legend-window / deep2d-filter-glyph-run / deep2d-http-transport / deep2d-glyph-run-contract / deep2d-uia-bridge / native-bloom-on-demand-entry / p2-02-zrender-chartir-rect-certification / deep2d-mainline-closure / de26-readiness-inventory / industrial-s0-evidence-inventory。
