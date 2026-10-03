# I-C19 生产链尾驻留与作者消费

## 现状核查

1. 全仓关键词 `keptMips|dynamicIbl|prefiltered-ibl|stageEnvironment` 已检索 packages/apps 源；git status 四项保留未跟踪文件（behaviorGraphDraft、deliverables、release-assets、release-staging）不触碰。keptMips 只由 CPU 状态机与 lab 消费，生产未接。
2. 契约已读 RuntimePrefilteredIbl、StudioEnvironment、PbrEnvironmentSource、SceneEnvironmentState。完整合法 mip 链与64 MiB包校验已有；作者仅有强度/背景/探针，未有链尾档位。
3. 依赖已查 deep-engine/contracts/web package.json 与 Native Cargo.toml。沿用现有 WebGPU/Three r185/vitest，无新依赖。
4. 消费方已查 PbrRenderer.stageEnvironment→createPbrEnvironment→prefilteredEnvironment/hdrEnvironment、PbrEnvironmentState、PbrMainBindings、StudioDeepEnvironmentSession、source identity、viewerEngineRig 与 SceneEnvironmentPanel。复用帧边界发布/回滚，不重建事务。
5. 测试/证据已查 prefilteredEnvironment/pbrMainBindings/StudioDeepEnvironmentSource 测试与 test-output/i-series-1001/dynamic-ibl：parity/hot-swap已有，降级只测有限值，明确排除生产采样钳制。
6. 已读 glm-handoff-20261001、remaining-tasks、i-c19-dynamic-ibl-cpu 与恢复台账。remaining 明确缺口为 keptMips 生产采样和作者消费；I-C16 另有状态机与HDR编码，但完整PT核只有接口，不声称已有完整内核。

**已有（不重建）**：预算判定、环境上传、GPU预滤波、源快照、帧发布与异常回滚、双缓冲反射记录、完整链 textureNumLevels 采样、作者环境热替换、真实GPU parity/hot-swap。

**真实缺口**：截断上传/生成，重定基后保留原粗糙度域，元数据随环境原子发布/回滚，作者保存型档位及源身份失效，真实降级采样断言。

## 最小实现

- PbrEnvironmentSource.keptMips 显式消费 CPU DynamicIblStagePlan.keptMips；缺省完整链。
- prefiltered 上传链尾；HDR/studio 只生成链尾，生成 roughness 仍使用原链 level。
- StudioEnvironment.specularMipSelection 携带 raw/kept/dropped；PbrMainBindings 在既有反射记录 reserved vec4 放全局/探针 dropped 值，记录布局与绑定不变。
- 采样 `clamp(roughness*(kept-1+dropped)-dropped,0,kept-1)`。仅 `roughness*(kept-1)` 会改变保留层的粗糙度标定，禁止。
- SceneEnvironmentState.environmentSpecularMips 为可选1..8；缺省不介入。经 scene.userData carrier进入源准备与身份核查，作者面板只在Deep可选。

本切片消费 CPU 计划输出；自动GPU全局预算仲裁/LUT跨代共享尚未接入，不能将 CPU 记账状态机当作GPU资源所有者并与帧事务重复回收。

## 验证与视觉

对标 Unity 的PBR采样域与工业资源约束，作者控件沿用base.css。聚焦测试覆盖参数拒绝零分配、链尾字节/原level、reserved packing、同族探针、作者源失效/桥快照。实际GPU probe要求两fresh轮：低roughness钳到首保留层，高roughness与完整链一致，资源收缩、热替换/回滚、零validation与dispose零资源。视觉两轮与10维打分由主线整合，未完成前不声称产品全绿。

## 本切片实测与移交

- deep-engine聚焦6文件68/68；采样/shader/探针/源快照/预算回归6文件55通过、2既有skip。补入CPU预算计划→source.keptMips→真实生产上传测试，随后prefiltered+I-C16状态机/HDR 4文件46/46。
- 作者源/桥26/26，作者select交互2/2（保存档位、完整档删除字段、非法值零写入、非Deep禁用说明）；contracts保存校验与探针11/11。
- deep-engine src/lab tsc、web tsc、contracts tsc全部0错；runtimePurity通过；sourceSize failures=0；git diff --check通过。新增源/测试叶均≤300行。
- 公共生产源冻结并交主线；GPU由主线串行执行 `node scripts/i-c19-dynamic-ibl-frame.mjs`。新 `lab/iC19KeptMipsProduction.ts` 用每mip不同常数指纹验证：sharpClampError≤.002、rough .8/1 preservation≤.002、sharpSignal>.01、GPU预滤波rough1全/尾误差≤.002、actualSavedBytes=expectedSavedBytes>0、dispose资源0。runner继续执行两fresh、数值稳定和源hash新鲜门。
- 本切片未执行GPU、未截图；GPU结果/作者视觉两轮及10维评分由主线补入。仅CPU校验不能关闭I-C19。

### 文件边界

生产叶：environmentMipSelection、studioEnvironment、hdrEnvironment、prefilteredEnvironment、pbrEnvironmentSource、pbrReflectionProbes、pbrReflectionProbeWgsl、pbrMainBindings、threeBridge/deepWebGpuOptions。PbrRenderer已有stage/create与发布/回滚路径直接消费，未改该大文件。

作者叶：contracts scene/sceneValidation、viewerEngineRig、studioDeepEnvironmentMips/source、SceneEnvironmentMips与Panel挂点。Lab与runner：iC19KeptMipsProduction、iC19DynamicIblProduction、i-c19-dynamic-ibl-frame.mjs。未改Native、全局任务表或台账；未commit/push；保留四项未触。

### 风险与后继

- 直接消费计划输出keptMips，并未把DynamicIblResidency变成GPU全局预算所有者；自动双驻留预算/LUT共享仍独立后继，避免与PbrEnvironmentState重复释放或破坏失败帧回滚。
- 作者面板为Deep WebGPU选项，默认缺省不介入旧路径；HDR自定义64底图只有7层，对超过源层数的显式请求fail-closed。作者当前默认128底图对应8层。
- 单层尾链roughness全钳0但其内容仍是原roughness1层；独立probe链使用自己的offset，同族已排查。

## I-C16 接手核查（只读）

已有 PathTraceProductSession、PathTraceSessionTypes、encodeRadianceHdr（29测再次全过），BVH/TLAS/命中参考及RNG。PathTraceReferenceKernel只有接口，无traceSample实现，无作者消费链；既有lightmapBaker明确不做离线PT。真实下一片是相机射线+Lambert/GGX多跳BSDF核、真实逐像素累积与批次取消，复用BVH/RNG/会话/HDR编码后才有可用出图入口。仅在实时光栅读回加导出按钮不能满足I-C16。不在本次冻结范围开启I-C16实现。

## 主线实测补记（2026-10-01）

GPU：`node scripts/i-c19-dynamic-ibl-frame.mjs` 两 fresh 通过，129600 样本的完整链 parity 最大0.0009765625、均值0.00007182996；热替换重复差0、代际回落正确、三次资源计数均54。kept3 的 sharpClampError/roughPreservationError均0，sharpSignal0.377075；完整/尾链分配字节10755068/10493948，节省261120，GPU预滤波尾层误差0，dispose后资源0，deviceErrors空。这里统计 texture 分配规格，不是驱动显存测量。证据：`test-output/i-series-1001/dynamic-ibl/evidence.json`，日志：`test-output/jc-i-20261001-i19-gpu.log`。

作者验收使用专用场景 `355b6475-3362-40a5-86f0-c1b52d23827d`，未保存原用户场景。Deep启用后选择“轻量 · 4层”并保存，整页重载恢复4；非Deep控件禁用且说明原因。最终源上，深色实际DOM视口1920×1080的两轮截图均显示球体、Deep启用及可用4层档位；第二轮经场景管理→编辑场景真实SPA往返。当前浏览器90%缩放下视口覆盖值1728×972才得到DOM1920×1080；此前DOM2133×1200观察不记作1920验收。临时覆盖已恢复。

SPA验收发现并修复Three shader installer在模块重载后丢失WeakMap注册的问题，完整canonical adapted字符串才允许恢复登记，部分修改继续拒绝；详见 `c8-three-installer-reload-20261001.md`。生产Deep shader、原Three对照和曝光均未改。保存截图：`test-output/i-c19-author-20261001/round-2-detail.jpg`（实际第二轮控件裁图，完整场景图在浏览器工具记录）。

### 十维自检（仅本次控件与采样范围）

| 维度 | 结果 | 依据 |
| --- | --- | --- |
| 布局 | 96/100 | 沿用环境面板单行表单，实际1080下可滚动到完整控件，无重叠 |
| 令牌 | 96/100 | 沿用base.css现有表单/背景/边界，不增加硬编码强调色 |
| 字体 | 96/100 | 中文短标签，层数与档位一行显示 |
| 状态与交互 | 97/100 | Deep启用可选，非Deep禁用说明，非法值零写入测试 |
| 动效 | 不适用 | 本控件未新增动效，既有场景交互保持 |
| 3D采样 | 通过数值门 | 原roughness域保持、边界钳制、尾层实读均通过；完整C8画质仍开放 |
| 信息设计 | 96/100 | 四档及减少反射显存的说明，无实现术语塞入作者流程 |
| 反馈 | 96/100 | 保存成功、重载与SPA重入档位恢复 |
| 响应式/主题 | 通过指定范围 | 仅用户指定深色1920×1080，其他尺寸/浅色未验 |
| 语义与可访问性 | 96/100 | label关联原生select，combobox可定位，禁用原因可读 |

对标依据为工作区指定的Unity PBR粗糙度一致性和西门子工业参数语义；UI复用既有设计，不新增视觉体系。可评分的七个控件维度均≥95，其余按适用范围记录，未把“不适用”算满分或宣称整个渲染器达到95。全局自动预算仲裁、LUT跨代共享、多设备驱动显存与完整C8画质另列后继。

最终补存整页 `test-output/i-c19-author-20261001/round-3-page.jpg` 与 `round-5-page.jpg`，两张均实帧显示sphere、Deep启用和可用4层。中间第4轮遇API watcher重启（日志 `data/logs/studio.out.log` 的 Restarting src/index.ts 与 `studio.err.log` 的4100 ECONNREFUSED），场景browse返回502，Deep明确保留WebGL且控件禁用；失败截图 `round-4-page.jpg` 与JSON状态保留，不计成功。服务恢复后整页重载得到第5轮成功。`author-rounds.json` 区分每轮结果；第3轮由浏览器截图API按屏幕像素保存，第5轮CDP按1920×1080裁窗保存，二者DOM视口均1920×1080。临时viewport恢复且验收tab关闭。
