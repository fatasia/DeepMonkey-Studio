# Web 宿主帧内失效保留

日期：2026-09-17。状态：帧内失效修复已实现；RAF sleep/wake 与 FrameLoop 宿主接线仍为本轮待办。

## 实际调用链与修复

`ViewerEngineCore.requestRender()` 汇聚相机、模型、资源和输入变化，调用
`ViewerRenderDemand.invalidate()`。`ViewerEngineRuntime.animate()` 在重型工作前调用
`shouldRender()`，在呈现后调用 `didRender()`。相机控制器的 change 回调和呈现回调
可能在两者之间再次请求重绘。

原实现的 `didRender()` 无条件清除 dirty；帧内请求超过其 settle 时间后不再有下一帧。
现在准入时记录 invalidation revision，呈现只清理对应 revision；帧内新请求保留至下一次
准入。不创建第二个场景、store、RAF 或渲染器，不接入 React/Vue/R3F/TresJS。

热路径保持 O(1)，新增两个数值字段，无按帧数组、事件监听器或闭包分配。
`shouldRender()` 是本帧准入，不是无副作用查询；宿主当前只有一个调用点。
只读模式 cadence 在准入后可能早退，下一次准入重新取 revision，避免额外残留帧。
未经过准入直接调用 `didRender()` 的既有初始化/测试行为保持兼容。

## 验证

- 聚焦命令：`pnpm --filter @bim-studio/web exec vitest run src/viewer/viewerRenderDemand.test.ts src/viewer/viewerMaterialActivity.test.ts src/viewer/viewerFrameCadence.test.ts`：3 文件 22 项通过。
- Web `typecheck`、聚焦 `git diff --check` 通过；业务文件 48 行，测试文件 99 行。
- 新增回归：帧内多次失效超过 settle 截止；连续源帧内停止后的最终帧；XR→隐藏→恢复保留失效；cadence 跳帧后的重新准入。
- 既有覆盖：120 ms 控制器收敛、连续动画/视频、后台云截图、隐藏编辑恢复、静态一分钟不执行重型工作。
- 未改变视觉、材质、光照、布局或令牌；未进行浏览器截图闭环，不把逻辑测试当作视觉或真实省电验收。

## 下一片：单 RAF sleep/wake 触发点清单

目前宿主仍保留轻量 RAF 检查。要停止空闲 RAF，必须在现有所有者内统一排队和取消，
而不是给 FrameLoop 再挂一个 RAF。

| 变化来源 | 当前入口 / 必须保留的唤醒与终态 |
|---|---|
| scene / resource / camera | Core.requestRender、markShadowMapDirty、Orbit change、Transform objectChange、模型异步加载完成、环境纹理完成与失败、resize / DPR |
| 用户与可见性 | Core.renderInputEvents、visibilitychange；隐藏期间保留 dirty，恢复补帧；指针/键盘回调不应创建多条 RAF |
| 显式连续源 | Core.setContinuousRender、viewerPerformanceBinding、cloud-capture；开始立即唤醒，结束保留最终帧，后台云截图不被 visibility 阻断 |
| 模型/场景动画 | Rig.setAnimationEnabled、Loading 的 mixer 注册、Interaction 的动画启停、Simulation.playSceneAnimation / pauseSceneAnimation / seekSceneAnimation；无需用户输入也能启动 |
| 物理 | Simulation.setPhysicsState、setPhysicsBodyState 异步完成、resetPhysics；物理 world ready 与 playing 切换都需要唤醒 |
| 导航/控件 | navigationMode、orbit.autoRotate、transform.dragging、相机飞行/visibilityTransitionCancels；阻尼结束前保留 settle，结束取消连续权 |
| 动态场景 | Rig.setWeather、工业 motionRoute / operatingState、scan / fire 效果、fragmentModels 更新与移除、Interaction.setInteractionScripts |
| 材质/后处理 | ViewerMaterialActivity 视频 playing/pause/ended/seeked/loadeddata、UV 动画配置与 once 完成、自定义 Shader/onBeforeRender、filmGrain/afterimage；刷新活动索引后再决定休眠 |
| XR / 销毁 | Rig.startXR 的 RAF→setAnimationLoop、finishXRSession 的恢复、Lifecycle.dispose；旧 callback 即使被浏览器取出也不能重新排队 |

其中 Simulation 的物理和场景动画启动、Interaction.setInteractionScripts 当前不直接调用
requestRender，依赖轻量 RAF 发现新活动；未补齐这些入口前不能停止 RAF。
后续须真实验证静态零 RAF、程序启动动画、资源晚到、XR 切换、后台恢复与销毁竞态。
FrameLoop 的异步 stage 顺序应在接线时与同步 host 明确统一，不能保留两套 dirty 状态。
