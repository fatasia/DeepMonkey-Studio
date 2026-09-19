# 主线收尾交接（2026-09-19）

这份文档是当前工作树的接手入口。它记录机器门禁真实结果、未完成收尾和 DE26 高价值范围；文件存在不等于验收通过，继续工作时以证据状态为准。

## Goal of next session

继续把 ⑥ D24–D28、⑦工业 S1–S6、⑧ DE26 readiness 的真实缺口补齐；②动态场景运行包已于 2026-09-19 晚间转 passed。已通过的 ①③④⑤ 只做必要回归。

## 2026-09-19 晚间推进（本会话，门禁 4/8 → 5/8）

- **② 动态场景运行包 → passed**。三端（Native winit 真窗口+真实时钟、WebGL、WebGPU 真 Chrome）以同一冻结包（SHA-256 `69b08b…`）各跑两轮，canonical 帧合同逐字节一致，六轮序列摘要均为 `040c1a9f7058f9c0`。证据：`test-output/dynamic-runtime-20260919-r1/`；文档：`docs/specs/dynamic-scene-runtime-playback-2026-09-19.md`；校验器 `checkDynamicRuntime` 已改为证据驱动。仍 deferred：相机/GLTF clip 通道、在线 dataBindings、脚本 interactions、多实例根节点语义、发布实窗内动态播放。
- **⑥ 门禁升级为内容推导**。新增绑定器 `scripts/fixtures/run-d24-d28-evidence.mjs`（汇聚 soak/故障/在线全链路/Native 对手报告→V01–V05 机器卡，`test-output/d24-d28-evidence-20260919/evidence.json`）；新增故障注入门禁 `apps/web/scripts/gate-post-acceptance-fault.mjs`（基线呈现/断网恢复/资源回收/设备丢失恢复，WebGL 与 WebGPU 双后端 4/4 通过，WebGPU 走真销毁 GPUDevice 回退路径）；`verify-mainline-closure.mjs` 的 06/07 改为内容推导（06 全卡 passed 才翻绿；07 passed=6 stage complete+7 profile productionReady，gap 枚举真实 profile 原因）。长稳政策：15 分钟实测才可绑定，V03 通过需 480 分钟生产级 soak。15 分钟 WebGL soak 首轮被并行负载污染（P95 尖峰）判失败，已在静默机器上重跑。
- **⑦ gap 文本机器化**：`7 of 7 profiles below productionReady` 等真实枚举进入 closure.json（profile 原因逐条可查）。
- **DE26 对标补充**：`docs/specs/de26-high-value-scope-analysis-2026-09-19.md` 新增第 7 节——Unity 6.4/7（2026-12 Beta、2027Q1 GA、统一渲染管线）、UE 5.8（MegaLights 生产化、Lumen Lite）/UE6（2027 底 EA）、Three r186+（WebGPU 2026-05 Baseline）、Babylon 9.0（Clustered Lighting/Frame Graph/Gaussian Splatting）的版本事实、能力映射、缺口 G1–G10 与反超差异化五条；均为提案，待拍板不入分母。

## State of play

最近一次主线校验：

```text
node scripts/verify-mainline-closure.mjs
passed=5, partial=3, blocked=0, unverified=0
```

已通过：①剖切 E2E、②动态场景运行包（2026-09-19 晚）、③ V11 Nature Kit、④发布链 OS 级证据、⑤ GI 跨端一致性。

仍需收尾：⑥ D24–D28 项目级后验收、⑦工业 S1–S6、⑧ DE26 资产/readiness。

这里的 5/8 是验收门禁计数，不是代码完成率。

### 八项目标状态

| 项目 | 当前状态 | 已有事实 | 关闭前必须补的证据 |
|---|---|---|---|
| ① 剖切 E2E | passed | Native 双变体双轮；`changedBytes=299000`，裁切/平面差异可复现。 | 后续若改发布或相机，回归原脚本即可。 |
| ② 动态场景运行包 | passed | 三端同冻结包各两轮 canonical 帧合同逐字节一致；证据 `test-output/dynamic-runtime-20260919-r1/`。 | 相机/clip 通道、在线 dataBindings、脚本 interactions、多实例根节点、发布实窗动态播放仍是明确 deferred 边界，扩展时按 `docs/specs/dynamic-scene-runtime-playback-2026-09-19.md` 记账。 |
| ③ V11 Nature Kit | passed | 48 候选、目录/缩略图/SHA/grounded 派生件通过；真实浏览器导入、项目资产插入、`dragTo` 投放、保存、刷新重开和 1024px 检查通过。 | 若改资源面板，重跑素材门禁；不要把按钮路径或派生 GLB单独当拖放证据。 |
| ④ 发布链 OS 级证据 | passed | 四窗口像素一致、API 停止后无 sidecar、六次隔离启动退出 0、当前主机只读 OS 预检通过。 | 不再追加 clean-machine 防火墙证明，除非用户另行指定。 |
| ⑤ GI 跨端一致性 | passed | r14 on/off 双格达到既定 normalized SSIM、MAE、edge F1 阈值。 | 复杂几何扩展是增强项，不阻塞既定主线。 |
| ⑥ D24–D28 项目级后验收 | partial | A04/A08 配对证据、V01–V05 卡合同存在；2026-09-19 晚新增：故障注入双后端 4/4、在线全链路绑定、15 分钟 soak 绑定（V03 生产门槛 480 分钟）、绑定器与内容推导校验器。 | 独立多资产跨端对手矩阵（V01 全量）、Native 对手运行（V02）、480 分钟生产级 soak、视觉/可访问性门证据（V04）、综合签核（V05）。 |
| ⑦ 工业 S1–S6 | partial | 六阶段矩阵、26 份报告的字节数/SHA 绑定；JT、X_T、RVT 等聚焦测试有真实结果。 | 混合场景、独立保留集、剩余 profile 晋级、版本矩阵、最终视觉验收和 OS 级边界；继续遵守 builtin/local/offline。 |
| ⑧ DE26 资产/readiness | partial；readiness=`unverified` | 6/6 load class、4/4 task kind、manifest/identity/轨迹/hash/许可边界已测量；Local GLB 派生统计可复现。 | `asset.bim.bimface-demo-1`、`asset.bim.snowdon-towers-arch` 的源级几何/材质统计；派生统计不能冒充源 RVT 统计。 |

### 本轮已经落地

- V11 资源面板现在使用资产专用 MIME，项目模型行可拖拽，投放目标是真实 React/DOM drop target。
- 对原生/WebDriver 丢失 `DataTransfer` 的情况，面板保留 drag-start 标识，并用原生 capture 监听补上 drop/dragend；仍以项目模型白名单和 `status=ready` 为准。
- 资源面板打开时场景树会卸载；门禁先关闭浮窗，再按 `data-asset-model-id`（而不是假设 instance id 等于 asset id）验证“已载入场景”。这修复了真实投放已发生但探针盯着隐藏/错误行的问题。
- 引擎尚未完成创建时的项目模型插入会排队，待 ViewerEngine 就绪后再执行，避免拖放动作静默丢失。
- 最新产物已通过 `pnpm --dir apps/web build`；最新素材门禁报告：`test-output/asset-material-flow/report.json`，其中 `inProductDragDrop=verified`、`saveRefreshReopen=verified`。

## Open decisions

### ② 动态运行包

先复用已有 v7 ABI，不重做编译器：

1. 给 WebGPU `SceneViewerRoot` 接入实际 frame scheduler 和渲染提交回调。
2. 给 Native 播放器接入真实窗口时钟、模型 TRS/动画帧消费和退出回执。
3. 以同一冻结 package 在 WebGL/WebGPU/Native 各跑两轮，记录 frame digest、presentation 时间和重放结果。
4. 只有三端都能从同一输入得到确定性结果，才更新动态门禁状态。

入口：

- `apps/web/src/delivery/dynamicRuntimePlayback.ts`
- `apps/web/src/viewer/viewerEngineRuntimeSupport.ts`
- `packages/deep-engine-native/src/runtime_package/dynamic_scene.rs`
- `docs/specs/dynamic-scene-runtime-audit-2026-09-18.md`

### ⑥ D24–D28

沿 V01–V05 卡逐项补独立证据，不把 A04/A08 配对报告复制成新卡：

- 两个以上独立资产的混合场景；
- Web/Native 的材质、阴影、文字和选择/剖切结果；
- 长稳运行与资源回收曲线；
- 断网、资源缺失、坏包、渲染设备丢失等故障注入；
- 功能、视觉、性能、可访问性、发布/恢复等全通道签核。

入口：`scripts/verify-project-post-acceptance-evidence.mjs`、`scripts/lib/projectPostAcceptanceEvidence.mjs`、`test-output/d24-d28-post-acceptance-20260919/evidence.json`。 <!-- handoff:allow secret -->

### ⑦ 工业 S1–S6

保持 profile 状态为 `inspect`/`preview`，直到每个 profile 有源身份、几何质量、材质/单位、版本矩阵、性能和混合场景证据。禁止用商业 SDK、在线转换或外部授权服务补洞；Parasolid 用户可见名称统一写 `X_T`，扩展名写 `.x_t`。

入口：

- `docs/specs/industrial-3d-format-work-plan-2026-09-16.md`
- `docs/specs/industrial-s1-s6-acceptance-matrix-2026-09-18.json`
- `test-output/industrial-s1-s6-evidence-binding-20260919/evidence.json` <!-- handoff:allow secret -->
- `scripts/fixtures/bind-industrial-stage-evidence.mjs`
- `scripts/fixtures/industrial-stage-matrix.mjs`

### ⑧ DE26 readiness

先补源级事实，再谈 readiness：

1. 为 BIMFACE 2017/unsupported-version 样本和 Snowdon Towers 分别保存来源、SHA-256、版本、授权边界。
2. 读取器能可靠解析时，输出源级 geometry/material 统计；不能解析时保留 `inspect`/`unverified`，不要用 GLB 派生件填空。
3. 更新 `readiness.json`、`readiness-evidence.json` 和报告的缺口计数，并重新跑主线校验。

入口：

- `scripts/inspect-de26-local-benchmarks.mts`
- `scripts/audit-rvt-source-profiles.mjs`
- `scripts/verify-de26-readiness-evidence.mjs`
- `test-output/de26-local-assets-readiness-20260919/` <!-- handoff:allow secret -->
- `test-output/de26-rvt-source-audit-20260919-r4/evidence.json` <!-- handoff:allow secret -->

### DE26 高价值范围（必须一起阅读）

范围整理的权威文件是 [`docs/specs/de26-high-value-scope-analysis-2026-09-19.md`](specs/de26-high-value-scope-analysis-2026-09-19.md)，绝对路径为：

```text
D:/Documents/bim/bim-studio/docs/specs/de26-high-value-scope-analysis-2026-09-19.md
```

接手时不要把 DE26 简化成第 ⑧ 项 readiness：readiness 只是 A02 的一块证据。DE26 还包括编译链、运行时、灯光/GI、材质、动画、数据、诊断、发布和复杂工业场景。

范围要点：

- 平台参照保留 Three.js、Babylon.js、Unity；Unity 是能力/视觉参照，不是运行依赖。
- V1–V7 做扎实，V8 小而强，V9/V10/V11/V13 按真实场景补齐；V12 扫描现场/Splat 方向不建设。
- 机器任务分母为 52 项，分为 A 5、B 8、C 8、D 4、E 8、F 3、G 8、H 5、I 3；计划基线不能直接当作当前完成状态。
- E 组验收必须拆开记账：多灯语义与单位、独立投接影、真实 GI、反射/材质、普通/实例/LOD/镜像/动画模型受光、作者→预览→保存→发布→Web/Native 重开。
- 只有 ABI/validator 没有消费者、只有 Web 没有 Native/离线重开、只有派生统计没有源级 RVT 统计、只有截图没有语义/性能/稳定性证据时，必须保持 partial/review-required/blocked。

依赖主线：

```text
A02/A03/A04/A08 ─┬─> B/C/E/G/F/H ─> V1–V13
D04/D05/D06 与 I04/I05/I07 在资产和运行预算具备后并行
```

## Skills to use

- `Code`：继续实现运行包消费者、工业 profile 和证据脚本。
- `e2e-testing`：补动态播放、项目后验收和发布实窗证据。
- `design-taste-digitaltwin`：涉及 3D/场景视觉改动时执行截图闭环。
- `documentation-and-adrs`：ABI、工业边界或验收合同变更时同步规范。

## Artifacts

### 复现命令

```powershell
cd D:\Documents\bim\bim-studio
pnpm --dir apps/web build
pnpm --dir apps/web gate:asset-material-flow
node scripts/verify-mainline-closure.mjs
node scripts/verify-project-post-acceptance-evidence.mjs
node scripts/fixtures/bind-industrial-stage-evidence.mjs
node scripts/fixtures/industrial-stage-matrix.mjs
pnpm exec tsx scripts/inspect-de26-local-benchmarks.mts test-output/de26-local-assets-readiness-20260919 <!-- handoff:allow secret -->
```

动态定向测试：

```powershell
pnpm --dir apps/web exec vitest run src/delivery/dynamicRuntimePlayback.test.ts src/delivery/compileSceneRuntimePackage.test.ts --reporter=dot
pnpm --dir apps/web typecheck
```

## 工作树纪律

- 保留其他会话的用户改动；不要 `git reset --hard`、`git checkout --` 或全量清理 `test-output`。
- 新证据使用带日期/轮次的目录；不要覆盖旧报告来制造“通过”。
- 只在报告、机器 JSON 和主线校验器同时反映事实后更新状态。
- 缺少依赖、样本或工具时，先查 `D:/Download`、仓内缓存、官方仓库和开放数据源；404 只记录该来源失败并继续找等价来源，不结束任务。
