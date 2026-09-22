# 动态场景运行包播放收口审计（2026-09-19）

## 结论

在 2026-09-18 审计（`dynamic-scene-runtime-audit-2026-09-18.md`）的基础上,本轮关闭了该文档
"最小可接线缺口" 第 2 条的三项真实播放证据:**WebGPU 帧播放**、**Native 真窗口播放**、
**跨端确定性重放**。同一冻结 Runtime Package v7(编译器动画产物 + v1 ABI 的 dataReplay/
interaction 通道)在真实 Chrome WebGL、真实 Chrome WebGPU(`--enable-unsafe-webgpu`)与
真实 Native winit 窗口(真实时钟)各播放两轮,canonical 帧字符串逐字节一致
(`dynamic-frame-v1` 合同),三端两轮全部确定。未关闭的语义保持 deferred,详见下文边界。

## 本轮新增(全部为生产代码,非测试桩)

- **跨端帧合同** `dynamic-frame-v1|t=<ms>|events=<revisions>|tracks=<sorted target>property=fixed6>`:
  Web 侧 `apps/web/src/delivery/dynamicRuntimePlayback.ts` 导出
  `canonicalDynamicRuntimeFrame`,Native 侧
  `packages/deep-engine-native/src/runtime_package/dynamic_scene.rs` 导出
  `canonical_dynamic_frame`;两端单测用同一条 golden 字符串互相钉死(含 `-0` 归一、
  目标/属性排序、时钟钳制)。SHA-256 由驱动统一计算,不引入第三份哈希实现。
- **Web 生产接线**:`sceneViewerDynamicPlayback.ts` 把冻结发布快照经既有
  `compileDynamicRuntime` 降级为 v7 carrier 包(render packet 为空,只承载 dynamic
  payload,不冒充发布工件),`SceneViewerRoot.tsx` 在快照携带对象 TRS 动画时通过
  `engine.startDynamicRuntimePlayback` 在真实 presentation frame scheduler 上启动播放;
  `startDynamicRuntimePlayback` 新增 `onFramePresented` 渲染提交回执(在引擎已渲染
  帧内触发,同时覆盖 WebGL/WebGPU 宿主)。
- **Native 真窗口播放**:新增 `--smoke-dynamic-package`;真实 winit 窗口 + 真实时钟
  (`Instant`),固定步长网格(100ms)决定"采样什么",真实时钟只决定"何时应用";每帧
  通过 `PlayerContent::apply_dynamic_playback_step` 消费 TRS(实例映射遵循发布绑定
  规则:primitive=节点 id、模型=`model-<contentHash>/` 前缀,T·R·S 列主序),经
  `Renderer::replace_render_packet` 做 diff-staged GPU 重提交,退出时输出 JSON 回执
  (canonical 序列 + 每帧 presentation 时间)。包缺 dynamic 通道时直接失败,不假装播放。
- **跨端重放驱动** `scripts/verify-dynamic-runtime-replay.mts` + harness
  `apps/web/scripts/dynamic-runtime{,-page}.html/ts`:esbuild 打包真实编译器编译冻结包,
  Playwright 真实 Chrome(headless、WebGPU 启用)驱动真实 `ViewerEngine` 播放同一冻结
  包,Native 用同一文件跑两轮,全部对比后写证据。

## 证据(机器可读)

`test-output/dynamic-runtime-20260919-r1/evidence.json`(2026-09-19 轮次 r1),要点:

- 冻结包 `frozen.runtime.json` SHA-256
  `69b08b2e7131cca9cec8d2d2d8cd6c6713abbdff238006c01e0e23d15922acbc`,schemaVersion 7,
  动画 + dataReplay(2 事件)+ interaction(select)三通道齐全。
- 11 个确定性步(t=0..1000ms,步长 100ms);canonical 序列逐字节:
  `nativeRoundRepeat=webglRoundRepeat=webgpuRoundRepeat=webglMatchesNative=webgpuMatchesNative=true`。
- presentation 时间为真实测量:Native r1 148 帧(帧序/毫秒/已应用步数),WebGL 两轮
  45/62 帧、WebGPU 两轮 34/35 帧,Web 帧携带 renderer drawCalls(5→3 等真实值)。
- 环境身份:Native exe SHA-256、Chrome 版本、平台、node 版本均在 evidence.json。

## 仍未关闭(继续 deferred,不能据此移除 deferred 标记)

1. 相机轨迹、GLTF clip 选择/时间策略等非对象 TRS 动画通道仍无编译映射与消费者。
2. 启用的在线 `dataBindings` 与脚本 `interactions` 仍 deferred;本轮 evidence 中的
   dataReplay 是**离线事件回放**通道,不含任何 endpoint/轮询/凭据。
3. Native 实例映射对"多实例模型内部局部变换"按单实例合成,复杂 GLB 内部层级的
   根节点 TRS 语义仍需专门切片;发布交付链(SceneViewerDeliveryManifest)尚未内嵌
   编译后运行包,SceneViewerRoot 的生产接线在客户端从冻结快照派生 carrier 包。
4. 发布实窗(独立 EXE 内的动态播放)证据仍属发布链门禁,不在本轮。

## 复现

```text
pnpm exec tsx scripts/verify-dynamic-runtime-replay.mts
cargo test --bin deep-engine-native player_content::dynamic
pnpm --dir apps/web exec vitest run src/delivery/dynamicRuntimePlayback.test.ts src/delivery/sceneViewerDynamicPlayback.test.ts src/delivery/compileSceneRuntimePackage.test.ts --reporter=dot
```
