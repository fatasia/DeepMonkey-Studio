# T14 根运动旋转增量应用 + 编辑器开关 UI 实施记录(2026-10-03)

## 现状核查
**已有(不重建)**
- `viewerEngineRootMotion.ts`:平移根运动应用、事件动作、T31 轨迹、`setModelRootMotion`/`getModelRootMotionState`(`ViewerEngineRuntime` 已暴露);
- 未跟踪 `viewerEngineRootMotionSampling.ts`:`sampleCycleCorrectedDelta`(回绕校正的平移+旋转增量采样)、`isIdentityRotation`,此前零消费方;
- 既有 `viewerEngineRootMotion.test.ts`(平移/回绕/事件);`ModelAnimationControl.tsx`(右侧检查器动画面板)无任何根运动入口,`setModelRootMotion` 此前无 `.tsx` 消费。

**真实缺口**:旋转增量只记录不应用(文件头 :25 注释);采样模块未接线;UI 开关缺失;复位/可用性探测缺失。

## 实现
1. **旋转应用**(`viewerEngineRootMotion.ts`)
   - 删除内联 `cycleCorrectedTranslation`,改用 `sampleCycleCorrectedDelta`(平移+旋转同口径)。
   - 解析:平移轨道定位被跟踪节点,同节点 `.quaternion` 轨道作为旋转轨道;仅有旋转轨道时**须显式 `rootNode`** 才解析(缺省不把任意骨骼旋转当根运动)。
   - 应用:父链世界旋转 W 共轭 `W·δ·W⁻¹` 后左乘实例旋转(绕实例原点),欧拉序沿用实例 `rotation.order`;位置+旋转合并为**单次** `setModelTransform`;节点平移/旋转钳回轨道起点,避免双重位移/旋转。
   - 单位增量(无旋转轨道/常量旋转轨道)不写回 rotation;仅旋转轨道且单位增量则完全不调用 `setModelTransform`。
   - 帧内零分配:全部模块级 scratch;`setModelTransform` payload 为三个复用常量对象(引擎只读取并拷贝,不留引用)。引擎侧 `getModelTransform` 的 `structuredClone` 属引擎既有开销,未改。
   - 快照新增 `appliedRotation`/`lastRotation`(世界四元数)。
2. **复位与可用性**:开启(关→开)时记录实例 transform 基线并清零累计量;`resetModelRootMotionPose` 还原基线;`getModelRootMotionAvailability` 探测活动 clip(无需先开启)。`ViewerEngineRuntime` 新增 `getModelRootMotionAvailability`/`resetModelRootMotion`。
3. **UI**(`ModelAnimationControl.tsx` + `sceneInspectorControls.css` 令牌化样式):"根运动"`role="switch"`(复用 `.toggle`,强调色全部 `var(--accent)` 派生)、读数 `Δ x.xx m · 偏航°`、复位按钮;禁用态(锁定/无动画/无平移轨道/无可复位)在包裹 span 上带原因 tooltip,并 `aria-checked`、`focus-visible`、`prefers-reduced-motion` 处理。

## 测试
- `viewerEngineRootMotion.test.ts`:旋转应用+钳回、循环回绕旋转持续前向、跨多圈、单位增量不写回、常量/纯旋转轨道不调用 setModelTransform、payload 复用、世界旋转共轭、开关关闭零行为、复位/基线、可用性、纯旋转缺省 rootNode 保护。
- 新增 `viewerEngineRootMotionSampling.test.ts`、`ModelAnimationControl.test.tsx`(SSR:四种状态/tooltip 原因/读数)。
- 视觉:临时 QA 页(已删)深色 1920×1080 渲染 开启/关闭/无轨道禁用/锁定 四态,与同面板其余控件令牌一致。

## 遗留
- 根运动开关为会话态(不入场景存档);实例 transform 被改动属预览行为,可由复位按钮还原。
- 旋转以实例原点为枢轴;父链在播放期间假定静态(与平移同假设)。
- 欧拉往返在 90° 俯仰附近等价但数值跳变(姿态正确)。
- T14 其余项(导入版本验证、GPU 蒙皮遥测、统一播放链)未做。

## 审查修复(code-review,2026-10-03)
1. **[Medium] 播放头相位**:`mixer.time` 是全局累计量(play 只 `reset().play()` action,仅 stop 归零)。新增 `viewerEngineAnimationPlayhead.ts` 的 `actionPlayhead`:动作已调度时取 `action.time`(loop 折回/once 钳制),未调度时回退 `mixer.time`(保持停止态读数)。`effectivePlayhead`(开启根运动镜像起点)与 `getAnimationPlayback`(UI 时间读数)同源改用它——后者原有同一错位(play 后读数含旧累计量),一并修正。回归:mixer 已累计后 play 再开启(相位 0.4 / 位移)、once 且 `mixer.time>duration` 后重播不丢位移并钳在 clip 末、`getAnimationPlayback` 同源、`actionPlayhead` 回退/钳制。
2. **[Low] 帧内分配**:`lastTranslation` 改预分配 tuple + `hasLastTranslation`,快照语义不变(尚无前进/复位后仍为 null,且为独立冻结副本)。
3. **[Low] 复位按钮误禁用**:`hasApplied` 改用四元数偏离单位旋转(`1-|w| > 1e-6`),任意轴旋转都可复位;读数由偏航角改为总转角(不分轴,无符号)。回归:仅绕 X 轴旋转 + 零平移时按钮可用。
4. **保存提示**:有已应用位移/旋转时在面板显示 `role="note"` 警示"含根运动位移,保存前建议复位"(`--warning` 令牌)。

## 遗留(追加)
- 根运动写入实例 transform 经 `setModelTransform`,会被当作作者编辑保存;忘记复位会固化漂移位置。当前仅 UI 提示,未做保存前自动复位/拦截。
- 基线在开关"关→开"时重新捕获:先关闭(未复位)再开启会以漂移后的姿态为新基线,复位无法回到最初位置。使用约定:复位后再切换开关。
- 停止/暂停态下 `mixer.timeScale=0`,`setTime` 不推进 `mixer.time`(既有行为,未改)。