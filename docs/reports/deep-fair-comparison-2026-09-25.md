# Deep vs Three WebGL 同场景公平对比与 P0 推进报告(2026-09-25)

执行:GLM(继续 `docs/handoffs/codex-to-glm-2026-09-25.md` 交接)。本报告记录本轮新增证据;既有报告(`engine-switch-integration-2026-09-24.md` 等)是各自时刻的快照,不自动覆盖本轮事实。

## 1. 公平性能门禁(P0-1a):新建 runner + 首轮基线

### 现状核查(交接 §4 的三项缺口已确认)

- `gate-render-engine-comparison.mjs`:只比 Three WebGL vs Three WebGPU(裸引擎夹具),Deep 引擎不在 `engines` 数组内,不能充当 Deep 胜出证据(交接已指出,本轮核实)。
- `engine-switch-integration-e2e.mjs`:有 input→present 指标与黑帧守卫,但场景/相机不固定(依赖开发 fixture 项目漂移位姿),无跨后端像素记录。
- `deep-gpu-stage-smoke.mjs`:单球诊断,不反映 Studio 同画质。

### 新建:`apps/web/scripts/gate-deep-fair-comparison.mjs`

- 协议:三后端(webgl/webgpu/wasm)在同一真实 Studio 页面、同一 fixture 场景上,每后端先"适应整个场景"复位相机,再依次执行:静置 120 帧 rAF 采样 → 三个固定位姿(前/右/顶,经方位魔方面按钮确定性触发)双拍像素 → 相同 120 步正弦拖拽轨迹的 pointer→submit/GPU 完成 p50/95/99 → 16 帧合成器采样的黑帧/亮度守卫。
- 守卫:黑帧=0、亮度下限、同后端同位姿双拍 SSIM≥0.99(确定性)。跨后端 SSIM/MAE 只记录不判(交接纪律:跨引擎画风差异不作失败依据)。
- 判定纪律:核心指标(静置 p50/p95、输入 p50/p95、pointer→submit p95、黑帧)全部不劣于 WebGL 才输出 `exceeds=true`;禁止从切换成功推导胜出。
- 产物:`test-output/deep-fair-comparison/report.json`、`report.md`、每后端×位姿 PNG。

### 首轮基线(2026-09-24T18:33Z,dev 服务器,守卫全过 0 失败)

| 后端 | 静置 P50/P95 ms | 输入 P50/P95 ms | pointer→submit P95 ms | 黑帧 |
|---|---|---|---|---|
| webgl(参考) | 7.00 / 7.20 | 7.00 / 7.20 | 1.60 | 0 |
| deep-webgpu | 7.00 / 13.90 | 7.10 / 27.90 | 15.80 | 0 |
| deep-wasm | 7.00 / 7.20 | 6.90 / 7.20 | 11.00 | 0 |

### 最终冻结轮(2026-09-25 凌晨,安静环境,含 WASM 相机同步减帧优化,守卫全过)

| 后端 | 静置 P50/P95 ms | 输入 P50/P95 ms | pointer→submit P95 ms | pointer→GPU 完成 P95 ms | 黑帧 |
|---|---|---|---|---|---|
| webgl(参考) | 7.00 / 7.10 | 7.00 / 7.20 | 1.30 | - | 0 |
| deep-webgpu | 7.00 / 13.80 | 7.00 / 27.80 | 16.50 | 67.80 | 0 |
| deep-wasm | 7.00 / 7.10 | 6.90 / 7.20 | 58.70(口径疑点) | 8.10 | 0 |

诚实结论:**"全面超过"尚未达成**。可感知帧节奏(输入 p50/p95 帧时间)上 WASM 三轮均打平 WebGL(7.2 vs 7.2ms),静置 p95 同样打平(7.1);**WebGPU 拖尾三轮稳定复现**(静置 p95 13.8-13.9、输入 p95 27.7-34.6、submit 14.7-16.5)是最明确的优化目标。WASM 的 pointer→submit 三轮波动大(11.0→36.8→58.7)而 GPU 完成仅 8.1ms:该口径受 wasm 内部自持渲染循环节拍支配(相机静止时疑似降频/跳帧),样本统计不稳,**不作为胜负证据**,后续需在 wasm 侧插桩定位提交节拍。像素:WASM MAE 4.6–8.4%,WebGPU 17.8–23.6%(画风差异记录在案)。

### 输入接管轮(2026-09-25,视口手势接管落地后,守卫全过)

| 后端 | 静置 P50/P95 ms | 输入 P50/P95 ms | pointer→submit P95 ms | 黑帧 |
|---|---|---|---|---|
| webgl | 7.00 / 7.10 | 7.00 / 7.20 | 1.30 | 0 |
| deep-webgpu | 7.00 / 13.70 | 7.00 / 34.80 | **4.20**(基线 15.8,-73%) | 0 |
| deep-wasm | 7.00 / 7.30 | 6.90 / 7.20 | 121.1(内部循环节拍口径) | 0 |

视口手势接管(提交 63db52ce)后:WebGPU pointer→submit 从 15.8 降至 4.2ms——手势事件由 Deep 画布直驱引擎中立控制器、消除了 OrbitControls 的中间帧,提交延迟接近 WebGL 量级;WASM 用户感知帧节奏(输入 p95 7.2ms)持续与 WebGL 打平。**剩余明确缺口:WebGPU 输入 p95 拖尾(27.7–34.8ms 三轮稳定)由一帧多提交的 GPU 排队主导**(submitGap p50=0 实测),下一刀在 deep-engine 渲染器的提交合并/收敛重绘节流,需 GPU profiler 专项。

**提交合并调查(本轮)**:`pbrRenderer.render()` 主路径已是单 encoder 单提交(收敛 preparation commandBuffers 与主命令为一次 `queue.submit`);runner 观测的多 submit 来自调用编排——TAA 收敛重绘(`TemporalFrameSettler.restart` 的 draw 快照重放)、`onSubmittedWorkDone` 补位(`completeCameraFrame` 重放 pending view)与手势帧提交叠加。因此优化对象不是"合并 encoder"而是**调用编排节流**:收敛重绘上限、补位重放与新手势帧的合并策略。该结论已具备,实施留待渲染器专项(需每 pass GPU 计时验证不伤画质)。

**节流实施轮(2026-09-25,提交 671d2eb5,安静窗口,守卫全过)**:桥编排节流落地——主路径去重(发起 sync 的帧不再预画,呈现成为该 view 唯一提交)+补位合并(GPU 完成不再即时重放,由最新 view 自然覆盖)。桥族 78/78、viewer 目录 839 过、Web 全量 4388。实测:pointer→submit 4.2→**3.8ms**(距 WebGL 1.2ms 一步之遥)、静置 p95 13.8 持平、Long Task 0;**输入 p95 拖尾 27.8 三轮不变**——CPU/编排侧已榨干,剩余拖尾为 GPU 完成队列深度(pointer→GPU 完成 ~100ms 恒定),属渲染器管线深度(多 pass 链)与 swapchain 帧节奏,优化需 GPU 计时专项,编排侧优化到头。

### 插桩轮(2026-09-25 凌晨,安静窗口,gesture 缓存生效,守卫全过)

| 后端 | 静置 P50/P95 ms | 输入 P50/P95 ms | pointer→submit P95 ms | submit 间隔 p50/p95 ms(样本) | 黑帧 |
|---|---|---|---|---|---|
| webgl | 6.90 / 7.10 | 7.00 / 7.30 | 1.40 | - | 0 |
| deep-webgpu | 7.00 / 13.80 | 7.10 / 34.60 | 14.70 | **0 / 6.3**(399) | 0 |
| deep-wasm | 6.90 / 7.20 | 7.00 / 7.20 | 35.30 | **0.1 / 4401.6**(18!) | 0 |

submit 间隔序列(本轮新增插桩)破案两个口径:

1. **WASM pointer→submit 35.3ms 是内部循环节拍,不是宿主延迟**:输入轨迹 120 步期间 wasm 内部仅 submit 18 次,存在 4.4 秒级大间隔——内部引擎在相机静止/低活动时降频跳帧。用户感知指标(输入 p95 帧时间 7.2ms)持续与 WebGL 打平,该口径真实且健康。
2. **WebGPU 拖尾的新证据**:submitGap p50=0(同帧多次 submit,399 次提交对 ~130 帧),一帧内多 pass 反复提交 + onSubmittedWorkDone 排队(limit 2)构成拖尾主体。下一刀方向:合并每帧提交(减少 submit 次数)/尾随 sync 与手势帧的提交合并/TAA 收敛重绘节流,而不是继续减宿主侧 CPU(gesture 缓存已把场景遍历从手势路径摘除,CPU 侧收益对未来大场景保持)。

## 2. P0-1b 本轮优化切片(以实测瓶颈为目标)

1. **WASM 相机同步减一帧**(`StudioDeepWasmBridge.queueCameraSync`):订阅回调本就每作者帧只触发一次,原实现再排 rAF 把相机同步推迟一帧(~16ms 结构性延迟)。改为同步执行,`sameCameraSnapshot` ε 去重兜底冗余 FFI。测试 3/3 通过。
2. **flight limit 1 vs 2 A/B(诚实回退)**:假设"在飞上限 2 排队放大 submit 拖尾",改默认 1 后重跑 runner,submit p95 反而恶化(WebGPU 15.8→19.9),且当时两个子代理正在本机录制桌面首帧(GPU 抢占污染数据)。数据不支持假设,已回退默认 2(合同测试锁定),在最终安静环境冻结轮复核。
3. **view 构建冗余清理**(`StudioDeepRenderView.renderViewSource`):`readStudioDeepFog` 每帧双读(一次喂网格会话、一次进 view),提取单次调用。地面网格 `getImageData` 已有 version 键控缓存(现状核查确认,不重复建设)。
4. **夹具合同修复(同族排查)**:并行会话的相机快速路径优化把"作者场景矩阵刷新"职责移到 presenter(`presentViewerFrame` 每帧 `scene.updateMatrixWorld()` 后才通知桥;桥只补刷相机节点)。`lights`/`environment` 两个桥测试夹具直接调用桥回调、未补 presenter 职责,导致灯光移动后阴影 viewProjection 断言稳定失败(**非产品回归,是夹具漂移**)。修复:夹具在通知桥前补 `scene.updateMatrixWorld(true)`,与产品合同对齐。修复后桥测试族 53/53、Web 全量 4372/4372。

## 3. Deep 纯编辑调用图(P0-1b 主线,本轮完成侦察)

八条仍锚定 Three 的权威路径(证据 file:line 见本轮侦察记录,关键点):

1. 作者态单一事实源:变换/材质/骨骼/gizmo 回写直接写 THREE 对象(`viewerEngineObjects.ts:330`、`viewerEngineRig.ts:253-293`、`viewerEngineCore.ts:445-472`),文档快照从 Three 读出(`captureSceneModelState.ts:12`)。
2. 输入/相机:OrbitControls/指针事件绑定作者画布(`viewerEngineCore.ts:425-433,565-571`);Deep 画布 `pointerEvents:none`(`studioDeepPresentationCanvas.ts`)。WASM 桥的 `StudioDeepWasmAuthorHost` 缝是现成引擎中立模板。
3. 拾取:全部 `THREE.Raycaster` + three-mesh-bvh(`viewerEnginePointer.ts:181-262`、`ordinaryPicking.ts:60-77`),Deep 无拾取查询 API。
4. gizmo:TransformControls 操纵数学全在 Three(`viewerEngineCore.ts:434-472`);Deep 侧每帧 CPU 投影顶点(`viewerEngineInteraction.ts:84-98`)。
5. overlay:选择框/测量/注释/灯光代理均为 Three 对象投影。
6. 每帧环境读取:灯光/雾/曝光/LOD 每帧从 Three 场景读出(`StudioDeepRenderView.ts:65-92`、`viewerFramePresentation.ts:22-26`)。
7. 帧循环所有权:Deep 监听器由 Three `animate()` 通知;仅 WASM 自持循环。
8. 收尾依赖:XR、离屏作者渲染、设备丢失恢复快照均以作者画布为前提。

替换顺序按依赖:1(作者态命令层)→ 2(相机/输入缝)→ 3(拾取 API)→ 4(gizmo 原生化)→ 5(overlay 自绘)→ 6(文档驱动环境)→ 7(帧循环)→ 8。**这是天级工程,本轮交付了侦察+模板定位+两个可验证切片,未完成全部替换——不宣称 Deep 纯编辑完成。**

## 4. 本轮其它 P0 完成项

- **P0-4 仓库治理(完成)**:README 增量补 `MIT License + Ethical Restrictions` 与 `source-available` 门禁文本;`LICENSE.zh-CN.md` 从旧 DMCSL-1.0 全文重写为 DMS-MIT-ER-1.0 中文便读版;`LICENSING.md` 三处过时说明更新;`CONTRIBUTING.md` 贡献条款、`apps/web/src/docs/community.md`、`apps/battery-native-runtime/Cargo.toml`(license-file)同步;`AGENTS.md` 治理段记录 2026-09-25 用户决策;`verify-dashboard-standalone.mjs` 的 `--licenses` 断言更新为 MIT+ETHICAL RESTRICTIONS;工业 worker 许可审计夹具标签更新;旧 `LicenseRef-Deep-Monkey-Community-1.0` 在生成侧清零(仅保留门禁只读兼容)。`pnpm gate:repository` 与 `pnpm audit:licenses`(529 包)双通过。
- **P0-2 Tauri 闭包(完成)**:最终 Native base(acbb870d…,09-24 17:50)之上重跑 `prepare-local-api-runtime`(507 包部署+11258 非运行时文件剪枝)→ Tauri release → NSIS + MSI(旧现场 MSI 目录为空)→ `verify:bundle` 通过。桌面验证代理完成最终二进制验收:
  - 哈希(SHA-256 实测):桌面 EXE `3a4c96e5…b06a1`、NSIS `dcb671e4…ed65d3`、MSI `5611a273…016ab4`;bundle 内 native EXE 与最终 Native base 哈希一致(证明新包基于最终 base,非旧 428d2f30… 包)。
  - 首帧两轮(PowerShell 15ms 轮询首窗+50ms×120 帧 PrintWindow/全屏交叉帧):round1 主窗 907ms 以纯深色 `#0b1114` 出现、round2 1125ms;242 帧白闪 0、中白/底黑 0,UI 2156/2267ms 渲染完成——**交接 §2"最终二进制视觉验收未闭合"已闭合**。
  - 启动链:`smoke-local-publication-runtime.mjs` EXIT=0(auth 200、发布与 Three 下载 200、启动器身份校验、SQLite sidecar);进程 0 残留。
  - 未验证项(如实声明):NSIS/MSI 实际安装卸载生命周期、安装包内部 PDB、<15ms 轮询间隙超短白闪、Factory Viewer GUI。3 条工程观察项(缺桌面专用首帧脚本、release 残留 5.4MB PDB、Tao 辅助窗先现)记录于 `test-output/desktop-publication-verification-2026-09-25/report.md`。
- **P0-3 全局回归**:API 全量 1562 passed / 0 failed(33.7s);Web 全量 4372 passed / 0 failed(夹具修复后复跑)。最终冻结后按需复跑。

## 5. 剩余缺口(诚实清单)

1. Deep 纯编辑 8 条路径替换(天级,见 §3 顺序)——未完成。
2. "全面超过"未达成:WebGPU 拖尾与 Deep 提交延迟需按 §1 基线继续优化;最终冻结轮需在无并行负载环境重跑 runner 取证。
3. Android 与最终本地安装版联测发布入口、全历史 secrets 扫描、素材逐资产许可审计(外发 NO-GO 项,交接 §4/§5)。
4. NSIS/MSI 的真实安装链(安装→启动→2D/3D/发布)证据以桌面验证代理产出为准,缺项如实记录。
