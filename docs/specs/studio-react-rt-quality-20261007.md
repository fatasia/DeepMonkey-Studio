# React、滑条与 RT 二反弹续作

## 现状核查

1. 全仓源码与未跟踪检索：已检查 git status，父会话负责图谱/DAG，Native 和 benchmark 另有会话在写，不触碰。range 同族分布于灯光、材质、对象特效、后处理等作者面板。
2. 合同：scene.ts/sceneMaterial.ts 已有所有光照与特效数值；rendererCapabilityManifestEntries 已有 secondBounce 说明；不扩合同。
3. 依赖：React 19.2、Vitest 4.1、esbuild 与已有 WebGPU 探针驱动齐备，零新增依赖。
4. 消费方：SceneLightEditor→sceneAppearanceCommands.changeLighting→引擎命令；ModelEffectsEditor→updateSelectedEffects 每事件 setRevision→useAppDerivedState 全量查询。既有 lighting 回调 100ms 合流和 revisionSettle 已落库，不重建。
5. 测试/证据：AppFormControls 的数字草稿及 Esc 测试已在库；RT secondBounce 的 CPU/WGSL 合同测试已在库，现有 rtSpecularGiGpuTest 仅 G1–G7，GPU 二跳缺证据。probe-app-perf-storm 已有真实隔离场景/React 提交/CPU 采样工具。
6. 规格：已读 13:36 交接、studio-quality-continuation、恢复台账相关项和已有性能证据说明。

**已有（不重建）**：数字草稿组件、全局 revision 尾沿、RT 二跳 kernel/执行器、CPU 镜像、一次反弹完整 GPU 探针。

**真实缺口**：受控 range 没有本地草稿，模型特效每事件推进全局 revision；没有独立 GPU 二跳命中与着色差分/CPU 仲裁；性能证据缺当前改动来源。

## 设计与边界

Design Read：参考西门子工业参数编辑的清晰数值、即时反馈和 Unity 实时预览；沿用 base.css 和既有控件排版，不改变风格。

共享 range 每事件本地更新 thumb/读数，直接预览引擎，结束同步提交应用状态与末值；禁用/取消/卸载取消待处理事件，防迟到回调写入新对象。Esc 恢复起点。键盘和数字路径明确结束语义。复用 revisionSettle 减少特效对全局昂贵派生查询的触发。未供给独立引擎预览的通用消费方保留 100ms 合流。

RT 探针仅扩展现有 probe 的 secondBounce 选项，新增独立 runner 仲裁第二命中、可见性、能量差分及 CPU 镜像，保留旧默认腿。GPU 构建/执行按父会话分配串行窗口。

验证边界：连续事件、快释放、blur/Enter、Esc、pointercancel、外部值变化、身份切换/卸载、disabled；GPU 命中/未命中、第二遮蔽、SSR 优先、零变化、错误 scope/哨兵。墙钟与 GPU timestamp 分口径，不混报。

## 验证

已接入灯光/GI/聚光阴影、材质/颜色调整/高级材质、模型特效/粒子、后处理。零新依赖。预览每事件直达引擎，React 全局状态、派生查询和历史在完成边界提交。实例/图层/材质槽/光源身份切换由 key 与捕获原回调隔离。外观详情保留受控展开，提交不会收起。

- 前端 7 文件 43 测试通过；121 次连续特效输入保留 121 次引擎调用，拖动期间全局 revision 从原 121 次降为 0 次，释放后 1 次。这是命令合同计数，不是完整编辑器 CPU 帧时。
- RT 6 文件 58 测试通过，涵盖同步 dispatch→indirection→finish 顺序、pending/failed 不分配瞬态、释放幂等与默认设备绑定预算。
- Deep typecheck（src/lab/examples）通过。web typecheck 首轮仅父分支 DataPipelineStudio.async.test.tsx locale 错误，父已修复并负责重跑。
- CUA 在隔离副本 `78e21669-1225-4801-9c3e-d1fbef28ec94` 实测：End 到 1、数字 Enter 到 0.37、ArrowRight 步进；按住拖动 0.51→0.90 后 Esc 恢复 0.51；灯光数字 2.75→键盘 2.80。两轮截图：[材质](../../test-output/react-range-20261007/round1-material.png)、[灯光](../../test-output/react-range-20261007/round2-light.png)。1280×720 深色，数字列无裁切，详情提交后保持展开，验收页已关闭。

## RT 根因与实测

实际二跳 GPU 探针先暴露 storage texture 5 槽超过默认 4 槽。新增二跳输入改用 unfilterable sampled texture + textureLoad，storage 降至 3 槽，一次反弹布局不变。正式帧瞬态纹理由错误的 GPUBufferUsage 修为 GPUTextureUsage；二跳表增加 TEXTURE_BINDING。第二遮蔽原点补回二跳 origin bias。

正式帧原先 void 调用 async encode，await validated 延后到主 encoder.finish 之后。现在保留探针异步 API，生产使用 ready 后同步 encodeValidated；待验证帧报告 `pipeline-validating`，失败帧保留错误原因。

探针在 Chrome 154.0.8037.98、NVIDIA Lovelace、128²、3 次预热/20 次采样下：833 二跳命中；命中身份、法线、材质、遮蔽、miss 能量、SSR 优先和关闭透传错配均为 0；264 屏外像素获得二跳能量。独立 CPU 几何重建采用 f32 世界坐标再执行 CPU TLAS，最大 travel 相对误差 0.1307%，保留 0.2% 门槛。最终源码复跑 GPU 链计时 p50 单跳 0.03584ms、二跳 0.052224ms，p95 0.03584/0.053248ms；墙钟 p50 2.80/3.10ms、p95 4.20/4.00ms。原始采样与当前源码哈希：[evidence.json](../../test-output/rt-second-bounce-20261007/evidence.json)。生产同步 API 修改后复跑已通过，GPU 窗口已交回引擎分支。

口径：GPU 探针执行真实 closest/indirection/fill，输入 SSR/法线为构造上传、材质为实例表；生产帧资源与顺序由 CPU 合同测试验证。未在本切片宣称完整编辑器 1080p 预算、贴图路径追踪、Native RT 或三引擎效果一致性达标。

## 视觉复核

对标口径沿用 `design-taste-digitaltwin` 的西门子工业参数编辑与 Unity 材质检查器。两轮仅验收本次控件范围：布局 9.5、层级 9.5、字体 9.5、配色 9.5、密度 9.5、数值格式 9.6、交互反馈 9.6、状态语义 9.5、动效克制 9.5、整体一致性 9.5。该自评分限于现有 1280×720 深色面板；全产品 Kimi-95 和获奖级结论须由主任务完整验收。

同族排查已覆盖上述六类作者参数。其他编辑器透明度、仿真/时间轴/音频等 ranges 保留原实现，完整 React shell 与引擎重算的 CPU 定标仍需独立场景性能轮次。

## React 全壳补测与轮询现状核查

已复核源码和 git 未跟踪状态、ProjectRecord 全字段/转换进度合同、现有 React 依赖、refreshProject 的轮询/导入消费方、导航 controller 测试、旧 React 审计/storm 规格。已有项目轮询和跨项目请求守卫不重建；真实缺口是每 2500ms API 返回内容完全相同的项目仍 setProject/setProjects，连带全壳与依赖项目的加载 effect 重跑。模型 progress 可在 updatedAt 相同情况下变化，不能只比较时间戳。补最新提交项目 ref 与完整快照相等早退，不关闭轮询。

当前 CUA 真输入采样：3 对象隔离副本，1280×720 Vite StrictMode，当前后端 WebGL；120 步鼠标移动实际触发 115 input。drag 235 次局部提交、6 次 App 提交；idle 1 秒 3 次 App、release 0.8 秒 5 次 App。input handler p95 2.818ms、局部 DraftRange commit p95 2.6ms、App commit p95 62.1ms；longtask 共 8 次（idle 3、drag 4、release 1）。周期整壳提交每 2500ms 成簇，与无条件项目刷新吻合。诊断用 CDP 包裹现有 Vite hook，采样后页面导航已清除临时 hook；完整 trace/profile 在 test-output/react-range-20261007。

## 生产 1080p 补测前核查

已检索 src/lab 与未跟踪探针、PbrRendererOptions / FrameMetrics / RenderView 合同、既有 esbuild/WebGPU 依赖、生产 pbrRtReflectionsFrame 及 validateFrame 消费方、现有真实 GPU 和 CPU 顺序证据、RT 规格。已有生产二跳与 GPU timer 不重建；真实缺口是生产 PbrRenderer 的 1920×1080 开关对照、完整帧 timestamp 与 validation 错误检查。使用同一既有反射场景生成正式 RenderPacket，固定相机/环境/MSAA、10 预热/30 采样，报告实际 dispatch 与完整帧（不将二跳 kernel 计时当成产品帧时）。

生产补测实际触发：初次直供 TLAS 在构造期调用 stageRayTracedShadowScene 时 features 未赋值；前移初始 features 后保留尾部 staging 失败裁决。其次生产阴影 void async encodeFrame 同样在 encoder.finish 后才开始 shadow-ray-mask-frame，引发GPU validation。ShadowRayFramePass/Controller 增加 ready/error 与同步 encodeValidated/encodeFrameValidated，异步探针 API 保留；生产改同步调用。14 focused tests 通过，首次修后真实生产30/30帧 closest+indirection dispatch，diagnostics 0，1920×1080 4xMSAA。生产完整帧 GPU p50 SSR1.114112ms / SSR+二跳2.555904ms，p95 1.376256 /14.09024ms；含校验读回墙钟另记。用户原页切Deep卡死反馈发生在此采样窗口，页已全部释放，CPU复测和离线显示暂缓优先调查；p95不得作为完全隔离终态。

## 最终生产 1080p RT 二反弹定标（2026-10-07 23:28）

正式 PbrRenderer 使用同一 3-instance 反射标准场景、固定相机、1920×1080 / DPR1 / 4x MSAA，比较 SSR 与 SSR+RT二反弹；两腿均启用同一 RT shadow / SSR，默认 contact 配置保持一致。每腿10帧预热后30帧采样，实际 closest 与 indirection 全部 dispatch，GPU validation 与 timer diagnostics 均为0。独立server bundle的10个来源叶均与当前源码SHA一致，acceptance=true。

| 指标 | SSR | SSR + RT二反弹 |
|---|---:|---:|
| 完整GPU帧 P50 | 1.114112 ms | 2.097152 ms |
| 完整GPU帧 P95 | 1.310720 ms | 2.424832 ms |
| 校验/读回墙钟 P50 | 4.0 ms | 5.1 ms |
| 校验/读回墙钟 P95 | 5.7 ms | 12.8 ms |
| 编码CPU P95 | 0.5 ms | 0.8 ms |

原始帧和来源SHA：[result.json](../../test-output/rt-production-1080p-20261007/result.json)；重算分位数与10叶身份校验：[final-summary.json](../../test-output/rt-production-1080p-20261007/final-summary.json)。该数据是标准场景定标，未把它用于 SMT / 2.4M 三角形的性能结论；原页编辑器性能使用真实生产采样另记。当前shader来源沿用c585冻结；后继CPU初始skin/morph bake仅变glTF解码，RT标准场景没有消费glTF。
