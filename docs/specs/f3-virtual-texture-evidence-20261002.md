# F3/T06 虚拟纹理真机证据(2026-10-02)

> 估时表行(docs/specs/remaining-tasks-estimates-20260930.md:132):"页表/反馈已接,补 SSIM≥0.99、
> 相机往返抖动/预算恢复/取消泄漏真机证据"。底座 7e271afe/beacb6a2,不重建。
> 结论:**四项真机证据全部通过**(NVIDIA lovelace,headless Chrome `--enable-unsafe-webgpu`),
> SSIM 0.992722 ≥ 0.99(原口径),并顺带修复两个真机盲区级生产缺陷(见 §3)。

## 1. 现状核查(progress-01-survey.json)

- **域源码(已有,不重建)**:CPU 侧 `packages/deep-engine/src/virtualTextures/`(页表 288 行
  plan/commit/rollback/evictTexture、反馈读取器、requests、诊断、options);GPU 侧
  `packages/deep-engine/src/webgpu/virtualTexture{Residency,ResidencyBudget,FrameBridge,PagePacking,Sampling}.ts`
  + `pbrRenderer.ts` driveVirtualTextures 私有接线。
- **既有测试**:12 文件 90 测(mock device),`virtualTextureSampling.test.ts` 明示
  "真机像素对照留联测脚本"——即本 lane。
- **既有真机证据**:`test-output/` 下无任何 VT 相关真机证据(rvt* 为 Revit 源审计,不同域);
  7e271afe 提交信息明示"真机SSIM与帧时留联测"。
- **真机缺口 = 本批四项**,真实缺口仅此,无重复建设。

## 2. 方法

- Runner:`packages/deep-engine/scripts/f3VirtualTextureGpuTest.mjs`(骨架同
  clothParallelGpuTest.mjs:esbuild → 本地 http → playwright headless Chrome → 证据 JSON)。
  `F3_VT_ITEM=a|b|c|d` 每项独立 run;每项 progress 文件
  `test-output/f3-vt-evidence-20261002/progress-0{2..5}-{a..d}.json`,证据
  `item-*/evidence.json`(含 sha256,见 progress)。
- Probe:`packages/deep-engine/scripts/f3VirtualTextureGpuProbe.ts`,真机
  `DeviceSession.open` + 生产链直调(反馈读取器→页表 plan→驻留 commit→layerOfPage→
  packPageTable→tile-lookup);**不复制渲染器私有 collectVirtualTextureFeedback**
  (相机语义以文档化代理条目驱动:可见 tile 集 × screenPixels)。
- 读回 harness:生产 tile-lookup pass 的 out buffer 私有、产品帧零 readback;联测读回按其
  注释口径使用同一份生产 WGSL + 同一 bridge 打包页表 + 同一 atlas 视图 + 同一样本布局自持缓冲。
- 纪律:帧时类测量本批禁测(并行负载)——全部证据为 SSIM/正确性/一致性读回;门限不降。
  争用重试:四项最终批次 retryCount 均为 0(无争用发生)。

## 3. 真机盲区级缺陷(本批发现并修复,`virtualTextureSampling.ts` 仅此一文件)

1. **WGSL 保留字 `meta`**:生产 tile-lookup WGSL 用 `let meta`,dawn(Win10 Chrome,
   2026-10)按规范拒编译 → **该 pass 在真机上从未真正执行过**(mock 测试不编译 WGSL,盲区)。
   同族教训已在 `wgsl/iesSampling.wgsl:9` 注释在案,属同族缺陷复发;全仓 WGSL 扫描仅此一处。
   修复:`meta` → `tileMeta` 纯改名。修复前证据:`item-a/evidence.invalid-all-zero-readback.json`
   (deviceErrors 记录完整 dawn 拒编译链)。
2. **pageUv 含 tile 全局偏移**:`pageUv = (vec2f(tile) + clamp(...)) × (mipEdge/atlasEdge)`,
   非 tile(0,0) 的采样越出页域被 clamp-to-edge 吃成边缘纹素。真机定位:修复保留字后
   SSIM=0.370713、97.8% SSIM 块低于门限、magenta=0(驻留完好)→ 纯页内 UV 数学错误;
   该 shader 自带注释"页内相对坐标 × (mipEdge / atlasEdge)"与代码自相矛盾,按注释口径
   去掉 `vec2f(tile) +` 项。修复后 SSIM 0.3707 → 0.992722。

修复均无合同变化:VT 域 12 文件 90 测全绿(mock 合同只锁 dispatch/打包布局,不锁 WGSL 标识符
与像素数学——这正是盲区根源)。

## 4. 四项证据结果(item-*/evidence.json,最终批次同一代码态)

| 项 | 场景 | 结果 | 关键数字 |
|---|---|---|---|
| **a** | SSIM≥0.99:虚拟纹理路径 vs 等价全量纹理基线,1920×1080 冻结尺寸(2,073,600 样本,1024² 合成纹理 8×8 页格全驻留) | **pass** | **mean SSIM=0.992722 ≥ 0.99**(独立复跑两次同值,复现);min 块 0.356929、1519/32400 块 <0.99 集中在页缝(无 gutter 的 tiled 采样固有 1 纹素缝,见 §6);maxAbsDiff=0.2446;magenta 哨兵=0;两图非恒值闸门过;生产 pass 冒烟 dispatch=1;deviceErrors=0 |
| **b** | 相机 A→B→A:poseA=左上 6×6(恰满 36 页预算),poseB=移位 6×6(A∩B=25,A∪B=47>36 真实压力) | **pass** | 终态页集与初始**全等**(sorted id 逐项相等);tile-lookup 输出**逐位一致**(maxAbsDiff=0,非恒值闸门过);B 阶段挤出 11 页 A 独有、回 A 再挤出 11 页 B 独有(差分口径);每帧 residentBytes≤预算 |
| **c** | 预算恢复:预算 16 页;S1=左上 4×4(基线服务)→全 64 tile 超压(defer 48/准入 16)→S2=右下 4×4(逐出 S1 全部 16 页=回收)→解除回 S1 | **pass** | 超压期每帧 residentBytes≤预算;squeeze 阶段驱逐 16(差分口径);恢复后页集与 S1 **全等**、9 tile 全部可采样、采样输出复跑逐位稳定;budgetHeldEveryFrame=true |
| **d** | 取消泄漏:maxUploadPagesPerFrame=4 制造 in-flight;路径 1=releaseTexture 中途取消,路径 2=bridge.dispose 中途取消 | **pass** | 路径 1:取消时点 32 页(在批 4+排队 28)=收口后 committed 4+rolledBack 28,整纹理 4 页收口后逐出,backlog=0、residentPages=0、打包 pageLayers 全 -1;路径 2:settleBatch disposed 分支回滚,disposed 后 API 全拒;`session.dispose()` 后 resourceMemory 全零(resourceCount/textureBytes/bufferBytes=0);deviceErrors=0、pageErrors=0、unhandledRejections=0 |

## 5. 证据文件

- `test-output/f3-vt-evidence-20261002/progress-01-survey.json`(现状核查)
- `test-output/f3-vt-evidence-20261002/progress-0{2..5}-{a,b,c,d}.json`(逐项里程碑,含证据 sha256)
- `test-output/f3-vt-evidence-20261002/item-{a..d}/evidence.json`(最终批次)
- 无效批次如实归档:`item-a/evidence.invalid-all-zero-readback.json`(读回链断裂+WGSL 拒编译)、
  `item-{b,c}/evidence.invalid-vacuous-output-check.json`(同断裂期输出比对为空比,页集结论仍有效)
- 本批足迹:改 `packages/deep-engine/src/webgpu/virtualTextureSampling.ts`(仅 §3 两处);
  新增 `packages/deep-engine/scripts/f3VirtualTextureGpu{Probe.ts,Test.mjs}`。未触碰
  jc-i-continuation、四项用户资产;无 commit/push/reset/clean/stash;无 cargo。

## 6. 剩余(F3/T06 行还差什么)

1. **帧时类真机数字未测**(本批并行负载明令禁测):tile-lookup 单帧耗时、页表打包稳定帧
   P95(现有 CPU bench 数字 0.001ms 为 CPU 口径)——待负载空窗批补。
2. **SSIM 页缝残差**:0.9927 的主要失分源是无 gutter 的页边界 1 纹素缝(1519/32400 块
   <0.99)。门限已过、原口径 0.99 不降;若未来材质主路径(C9 域)要求更高,方向是 atlas 页
   gutter/双线性外扩,属材质路径接入工作,不属本行。
3. **生产接入深度**:tile-lookup 目前是独立消费 pass(与未来材质路径同构、同一页表合同),
   pbrShader 主 pass 接入归 C9 在途域;相机代理为文档化口径,渲染器私有反馈链
   (collectVirtualTextureFeedback)的端到端真机联测随 C9 主 pass 接入一并收口。
4. **估时表行回填**:由 root 统一回填(本报告为依据),本 lane 未改
   remaining-tasks-estimates-20260930.md。
