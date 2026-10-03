# F5 行第四层根因调查与修复 — f5-l4-root-cause-20261002

> 2026-10-02。底座:`docs/specs/f5-gi-fix-20261002.md`(L3:内核合同/捕获阴影射线/syncPacket 三修复已落,
> 封门 leakRatio 1.052/1.845/0.999 未达门,第四层根因已定位待调查)。
> 本刀:两根因正确语义判定 + 修复 A(捕获饥饿)+ 修复 B(ambient 输入)+ 两轮真机 fresh + 诚实边界。
> 证据:`test-output/f5-l4-20261002/`(两轮 state/metrics/截图 + 4 个诊断脚本 + 4 份 progress JSON)。
> 禁 cargo(未触碰 Rust 链);帧时按指令豁免未测;不改 jc-i-continuation。

## 0. 结论速览

| 项 | 判定 |
|---|---|
| 根因① 捕获调度语义 | **判定+已修**:捕获不该按需;已与渲染需求解耦(产品捕获泵),封门静置 240 tick 后 36 批 287 更新、drained、探针黑且有效 |
| 根因② ambient 输入语义 | **判定+已修**:F1 合同链的正确值 = 环境立方体均值(slice-2 取代 slice-1 过渡 [0,0,0]),但须乘与显示端 envIrr 相同的 environmentIntensity;已修+合同注释链更新+钉子测试 |
| 封门 leakRatio | **intBackWall 1.027 ✓ / intPartition 0.966 ✓ / intFloorBack 1.843 ✗ 未达门**——两轮 fresh 逐位一致;残余载体已用证据链精确定位到**显示管线语义层**(见 §4),不属于捕获/ambient 链 |
| 动态/室外零回归 | **PASS**:patchA/B/republish 与 L3 差 ≤0.15/255,红反弹语义保持(+6.3),GI-off 基线对 L3 哈希逐位一致,室外 MAE 0.00214 |
| 双轮 fresh | round1/round2 全部读数逐位一致(确定性渲染) |

## 1. 现状核查(progress-01/03)

### 根因① 捕获调度链(为何静置只 1 批 8 更新)

- `viewerEngineRuntime.animate`(`apps/web/src/viewer/viewerEngineRuntime.ts:80`)每 RAF 先过
  `ViewerRenderDemand.shouldRender`;静置(dirty 消费完 + settle 120ms 窗过 + 无 continuous)→ 重帧整条跳过。
- Deep 捕获唯一驱动点 = `pbrRenderer.renderPreparedFrame:510 driveProbeClipmap:394` → session.beginFrame
  (串行:1 在飞 + 1 排队);重帧停 → 捕获停。
- "8 更新/批"出处:产品工厂 `pbrRenderer.createProbeClipmapController:337` 固定
  `frameBudget = 8`(8 探针 × 32 方向 = 256 射线预算,注释在案)——非缺陷。
- 未捕获 texel validity=0 → 纹理采样 totalWeight=0 → gi.a=0 → `mix(envIrr, gi, 0)`=全量 IBL。
- 封门后**陈旧探针不是问题**:`ProbeSurfaceCachePacketConsumer.sync` 对全部实例 upsert 新 revision,
  全场景 AABB 进 pending(dirty 覆盖全屋)——唯一缺口就是静置不推进。

### 根因② pbrRenderer:440 的 ambient 源与 F1 合同出处

- `pbrRenderer.ts:432-443`:env 身份变化 → `EnvironmentAmbientReader` GPU 读回立方体 6×8×8=384
  样本均值 → `syncLighting({primary, ambient})` 喂 producer。
- **F1 合同链两段**(以文档为准):
  - slice-1(过渡):`probeSceneRadianceProducer.ts:40`"本切片由宿主以 [0,0,0] 起步;环境均值读回属后续切片";
  - slice-2(权威):提交 `d1626b2f`"F1 slice-2 environment-average ambient GPU readback feeds probe capture";
    `environmentAmbientReader.ts` 头注释"作为探针一跳捕获的 ambient 项"。
- **判定:ambient 正确值 = 环境立方体 GPU 读回均值**(slice-2 已取代 slice-1 过渡值);
  回退 [0,0,0] 违反 slice-2 合同且让室外探针丢天空填充。底座"非 F1 声明的 [0,0,0]"引用的是
  已被取代的过渡合同——**根因②的原表述不成立,但其调查方向引出了真缺陷(强度失配,见 §2 修复 B)**。

## 2. 修复内容(diff 摘要)

### 修复 A:捕获泵(捕获与渲染需求解耦)

| 文件 | 内容 |
|---|---|
| `threeBridge/DeepWebGpuProbeClipmapSession.ts` | `lastView`(复用已分配快照)+ `captureTick()`(pending→busy / 失败闩→unavailable / 无欠账→idle / 有→submit(lastView))+ `hasPendingWork()`(surfaceCache.pendingCount>0 ∨ runtime 无快照 ∨ frameStats.deferredCount>0) |
| `threeBridge/DeepWebGpuBackend.ts` | `probeCaptureTick()` 透传(assertOpen) |
| `apps/web/src/viewer/StudioDeepWebGpuBridge.ts` | `pumpProbeCapture()`:RAF 心跳,仅 submitted/busy 自续;每次 deep 帧绘制后武装(覆盖探针启用/包修订/相机事件三类需求源);hidden 暂停;收敛自停 |

- 预算合同不破:泵只重新触发会话既有的串行批次提交(仍受 updateBudget/公平轮转约束);
  失败闩防无限泵(宿主下一渲染帧单次重武装)。
- **稳态零分配零调用**:空闲=无 RAF 无 tick;工作期 allocations 全在既有捕获路径内。

### 修复 B:ambient 强度一致性 + 合同注释链

| 文件 | 内容 |
|---|---|
| `webgpu/pbrRenderer.ts:440` | `ambient: scalePbrEnvironmentRadiance(this.environmentAmbient, view.environmentIntensity)`——捕获 ambient 与被替换的显示端 envIrr 同强度。`scalePbrEnvironmentRadiance` 自带合同:"CPU reference for IBL radiance **before GI blending**" |
| `rayTracing/probeSceneRadianceProducer.ts:40` | 接口注释更新为两段合同链 + 强度一致性要求 |
| `webgpu/pbrRenderer.ts:427` 注释、`rayTracing/probeSceneRadianceProducer.test.ts` | slice-2 合同钉子用例(环境均值 (0.525,0.563,0.613) 单独驱动捕获 + uniform float12 偏移断言)+ 禁止回退硬零的裁定文字 |

- 原理:显示端 `envIrr = cube × intensity`(uniform `lightDirection.w`);捕获 miss 值若为原始
  cube 均值,valid 探针携带 `1/intensity`× 的天空能量替换 envIrr → 门态无关洗光。
- 实测:封门室内探针由 (0.0028→0.0007)(L3)进一步降到 **0-0.0005**(黑),体积 meanLumValid
  0.00447、brightValidCount=0、maxRgb 0.0085——完全脱离环境均值(修复前 max 0.0125 ≈ 环境均值)。

### 同族排查与一处还原(诚实记录)

- 对 `texture_2d_array` 的 `textureLoad` 签名做了规范核查(语言参考:coords, **array_index**, level
  ——layer 在 level 前):**原采样代码 `(coords, layerBase+cell.z, 0)` 本来就正确**;调查中一度改写
  已还原,现文件仅保留签名注释(`probeClipmapTextureSamplingWgsl.ts:77`)。其余 textureLoad 调用点
  (2D 纹理)逐一核对无误。
- 诊断基建(不入库,均落 test-output/):metadata 合法读回管线(一次性 compute uniform→storage;
  `copyBufferToBuffer` 因 buffer 缺 COPY_SRC 恒读零,先前"元数据全零"为读法伪影)、位探针着色器
  (帧错位排除)、sun×GI 2×2 矩阵。

## 3. 真机验证(两轮 fresh,round1 ≡ round2 逐位)

### 封门静置体积读回(验收核心,任务书口径:静置 240 tick)

| 读数 | 修复前(L3 修复轮) | 本刀(两轮同) |
|---|---|---|
| stillConverge | 需正负交替脉冲驱动,覆盖 32-40/≈150 | **一次武装 + 静置自收敛**:240 tick,drained=true,36 批 287 更新 |
| validCount | ~8(近邻首批) | 141(≈全部在场景探针集,其余为场景盒外单元,设计内不捕获) |
| 封门室内探针 rgb | 0.0028→0.0007(部分) | **0-0.0005(黑),validity=1** |
| rgb 分布 | max 0.0125 ≈ 环境均值,均匀 | meanLumValid 0.00447,darkValid 58.9%,brightValidCount=0,max 0.0085——**脱离环境均值** |

### 封门 leakRatio(登记口径 sealedDelta[0]/max(openDelta[0],0.01),两轮同)

| region | L3 | 本刀 | 门 ≤1.05 |
|---|---|---|---|
| intFloorBack | 1.845 | **1.843** | ✗ |
| intBackWall | 1.052 | **1.027** | ✓ |
| intPartition | 0.999 | **0.966** | ✓ |

**intFloorBack 未达门,按条款不放门。** 残余载体已排除捕获/ambient 链并精确定位(§4)。

### 动态/室外零回归

- patchA [221.36,214.91,215.05] / patchB [215.76,210.15,210.96] / republishA [221.4-221.5,…]——
  与 L3 差 ≤0.15/255;红反弹语义保持(R−B=+6.3,A 态红移/B 态衰减);重发布等价。
- GI-off 基线四张(外景/室内 open/sealed/动态)对 L3 **PNG 哈希逐位一致**(GI-off 路径未触碰的直接证据)。
- 室外 MAE(gi-on/gi-off vs L3)= 0.00214;screencast 收敛序列无残影。

### 测试与类型

- 新增 `DeepWebGpuProbeClipmapSession.captureTick.test.ts` 5 用例(busy/复用 view/idle 判据/失败闩/dispose)。
- producer slice-2 合同钉子 1 用例(环境均值独立驱动捕获 + uniform 断言)。
- 家族回归:lighting+rayTracing+threeBridge 1080/1080 绿;captureTick/session/producer/采样 30 绿。
- deep-engine `tsc --noEmit` 净。`apps/web` 仅剩未跟踪并行文件
  (`deepOverlayDomainChannelReadback.test.ts`)与并行在途 `pbrShader.ts` 改动引发的
  `pbrEnvironmentIntensity.test.ts` 字符串断言失败(断言串在 worktree 与 HEAD 均不存在,
  与本刀改动无关,并行域)。

## 4. 残余载体精确定位(诚实,未达门部分)

封门 GI-on 在体积全黑+valid 的情况下仍比 GI-off 亮 +29.8/+39.9/+57.3(中性白)。证据链:

1. **非探针内容**:体积全卷无任何 texel lum>0.05(max 0.0085);临时调试着色器强制 gi≡0、a≡1
   (位探针:全场景暗 → 着色器 world 即世界系,帧错位排除),封门室内亮度不变(~157)。
2. **非元数据**:显示侧 binding 身份对拍(view/levelMetadataBuffer === 发布 binding)+ metadata
   合法读回(compute uniform→storage;level0 origin(-12,-6,-6) spacing 2 max(18,8,24) 与 plan 逐值
   一致,房间在 contains 域)。
3. **非 envIrr 强度旋钮**:setEnvIntensity(0) 行与 0.25 行读数不变(re-staging 异步,实验不决定性,
   与底座结论一致)。
4. **定位**:GI 开关实际切换的是**渲染管线变体**——GI-off(hasProbeClipmap=false)走
   `fragmentMainDisplay*` 直显变体(无 eye.w IBL 块,实测 ≈30-176),GI-on 走 `fragmentMain`
   全量变体(eye.w IBL 块:envIrr 漫射 + **无遮挡镜面 IBL** + 探针漫射)。黑探针把漫射 envIrr
   正确压到 0,但**镜面 IBL(roughness 0.5 下 specFraction≈0.37,量级 +30-60)无探针遮挡、
   门态无关**,构成 sealedDelta 的主体;另 thinwall 捕获体积全卷无 sun-lit texel(maxRgb 0.0085,
   而室外探针理论 ≈0.1+,跨 L2/L3/L4 存在,动态场景红反弹正常并存)——两项均为**显示管线/捕获
   主光语义**,不在本刀"捕获调度 + ambient 输入"范围内。
5. **移交建议**(下一刀,建议先做 frame ABI 级审查):a) GI-on 的镜面 IBL 项与探针 validity 的
   门控语义(探针 valid 域是否应以遮挡/强度压低无遮挡镜面);b) 直显变体与全量变体的项集对齐
   (GI-off 基线与 GI-on 的项差异即 leakRatio 的系统性偏置);c) thinwall 捕获主光缺席
   (`sceneLighting.primary` 在该场景下的解析链)。

## 5. 10 维自评(逐维 1-10,证据为本机实测)

| 维度 | 分 | 依据 |
|---|---|---|
| 根因判定正确性 | 9 | 两语义判定均有文档/提交/代码三重出处;捕获链逐环节实测 |
| 修复 A 正确性 | 9 | 泵机制两轮 fresh 实证(8→287 更新/drained);预算合同保持;失败闩 |
| 修复 B 正确性 | 9 | slice-2 合同为准 + 显示一致性缩放;封门探针黑化 4× 实证 |
| 封门哨兵 | **4** | intFloorBack 1.843 未达门,如实登记;2/3 区达标;残余载体证据链完整并移交 |
| 回归控制 | 9 | 动态 ≤0.15/255;GI-off 哈希逐位一致;室外 MAE 0.002 |
| 证据链完整性 | 9 | 两轮 state/metrics/截图 + 4 诊断脚本 + 4 progress JSON + 位探针/矩阵中间证据 |
| 诚实边界 | 10 | 未达门直说;textureLoad 一度误改已还原并记录;元数据"全零"读法伪影自纠;并行域失败如实标注 |
| 同族排查 | 9 | textureLoad 全调用点核对;WGSL 签名规范核查;diffuseIrradiance/直显变体逐项排除 |
| 复现性 | 10 | 两轮 fresh 全读数逐位一致 |
| 工程纪律 | 9 | 禁 cargo/不改 jc-i-continuation/保护并行在途(未触碰)/里程碑落盘 |

**综合:封门哨兵一维 4 分不达标 → 不放门,如实移交(§4)。**

## 6. F5 行剩余(移交)

- [ ] §4 三项(镜面 IBL 门控语义 / 管线变体项集对齐 / thinwall 捕获主光缺席)。
- [ ] Rust 镜像(probe_gi_grid.rs)待 cargo 线复测(沿 L3)。
- [ ] 帧时与真机 GPU 复测(沿底座遗留)。
- [ ] Chebyshev 通道独立方向性验证(沿底座遗留)。

## 7. 运行方式

```bash
node test-output/f5-l4-20261002/f5-l4-gate.mjs 1        # round 2 同理
node test-output/f5-l4-20261002/f5-l4-metrics.mjs 1     # 对 L3 round2 对照量化
node test-output/f5-l4-20261002/f5-l4-diag-levels.mjs   # 元数据/绑定身份/帧探针诊断
node test-output/f5-l4-20261002/f5-l4-diag-matrix.mjs   # sun×GI 分解矩阵
```
