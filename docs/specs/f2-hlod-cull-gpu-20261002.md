# F2:驻留感知 HLOD/簇隐藏 —— 生产 transport/pass 接缝现状与冻结场景 GPU 对照

- 日期:2026-10-02;线路:F2/B4/G1/T05/T26(估时 6-12h,中信心);基线 commit `78e75379`
- 证据目录:`test-output/f2-hlod-cull-20261002/`(progress-01/02/03 + evidence.json + evidence2.json,fresh×2 均 PASS,逐像素统计逐值一致)
- 代码:`packages/deep-engine/scripts/{f2HlodCullShared,f2HlodCullPayload,f2HlodCullGpuProbe}.ts` + `scripts/f2HlodCullGpuTest.mjs`(全部为新增,**生产源零改动**)

## 1. 现状核查结论(六步,详见 progress-01-survey.json)

### 1.1 簇隐藏的生产 dispatch 形态(已接,两条路径)

折叠簇 = **代理绘制 + 成员实例 1e-6 缩放隐藏**(实例数恒定,批几何引用恒完整):

| 路径 | 接缝点 | 形态 |
|---|---|---|
| 非流送(authorChunks 关闭) | `DeepWebGpuBackend.prepareRenderPacket` / `prepareView` → `applyHlodPlanToInstances`(threeBridge/hlodClusterStream.ts) | 隐藏成员缩放不可见 + 全量代理追加(活动=真实变换,非活动=缩放),经既有实例管道成批 |
| 流送(authorChunks 开启) | `AuthorChunkStream.sync/syncView(clusterPlan)` → `applyClusterPlan`(authorChunkStream.ts:112/155/188) | 每活动代理 = 独立 overlay 块(`hlod-cluster:<id>`)+ 1 批 + 1 draw |

时序 Hi-Z 通道(与 HLOD 共存于生产帧):`PbrRenderer` 每帧 `previousHiZ.beginFrame/occlusionView` → `encodeCulling(opaque, {previousHiZ})` 与 `encodeLod({previousHiZ})`(pbrRenderer.ts:555-602);Hi-Z 构建 `HiZPyramid.encode` 挂 `PbrPostProcessChain`(features.occlusionCulling)。F1 帧图身份层把 `build-hiz`/`publish-hiz` 标为未纳入第一切片——是**计时身份未括夹**,不是通道未接。

### 1.2 缺口(接缝现状如实)

1. **①合批 1-draw 代理计划未接生产传输层**:`HlodProxyDrawBatcher`/`hlodProxyBatchInstances`(webgpu/hlodProxyDrawBatch.ts,B4 切片)是纯 CPU 计划层,**无生产消费方**;流送路径仍逐代理 overlay(1 代理=1 draw)。batchBench `realGpuChecklist` 第 3 条标注"两文件在途域,留主线程接线"——本切片不接(他人在途域),只供证。
2. **②冻结场景两态 GPU 逐像素对照缺失**(本切片补齐,见 §2)。
3. **③时序 Hi-Z×折叠交互**:帧内构建通道可用(本切片对拍,见 §2.3);跨帧 `previousHiZ` 两帧往复 × 折叠决策交互未在本 probe scope,如实登记留项。
4. **gpu-pass:hlod-proxy 逐 pass 计时**:本批帧时禁测(并行 GPU 负载),留项。

## 2. 真机 GPU 对照(nVIDIA Lovelace,headless Chrome `--enable-unsafe-webgpu`)

口径:T00 车间 10k(真实 GLB accessor 包围)× 生产 `decideHlodFrame`(默认 targetPixelError 8/迟滞 0.12)× 相机阶梯 0.25×/1×/4×/64×;960×540 冻结尺寸;r32uint 对象 ID 附件逐像素读回。
**两态定义**:A=全量实例腿(真实节点世界 AABB 盒 ×10000);B=折叠腿=**生产 `applyHlodPlanToInstances` 输出**(隐藏成员 1e-6 缩放 + 全量代理网格追加,13138 实例)。变换打包走生产 `packTransform`;ID/轮廓 pass 为 probe 自持 WGSL(生产无 GPU 对象 ID 附件通道,见 §1.2-①)。

### 2.1 对象 ID 两态对照(门限:真缺=0、隐藏成员像素=0)

| 相机 | A 覆盖 px | B 覆盖 px | 真缺 missTrue | 隐藏成员像素 | 未折叠区成员 id 一致 | 代理替代 px | 成员互换 px |
|---|---|---|---|---|---|---|---|
| 近 0.25×(23 代理) | 380290 | 380290 | **0** | **0** | 378754 | 1536 | 0 |
| 巡航 1×(1747 代理) | 107244 | 107244 | **0** | **0** | 61004 | 46240 | 0 |
| 远 4×(242 代理,全折叠) | 5748 | 7261 | **0** | **0** | 0 | 5748 | 0 |
| 航拍 64×(1 代理,根折叠) | 26 | 30 | **0** | **0** | 0 | 26 | 0 |

- **真缺=0**(A 覆盖、B 经 1px 膨胀后仍空):四相机全 0 → 代理是像素级保守超集,与生产合同一致。
- **隐藏成员像素=0**:1e-6 缩放隐藏在真机上零像素——非流送"缩放隐藏"合同的同机直接验证。
- **代理误差显式计量(不美化)**:巡航档 46240/107244 = **43.1%** 覆盖像素的最近表面被代理盒替代(折叠成员的表面语义由盒代理承载);远档 B 覆盖比 A 多 1513px(**+26.3%** overhang,合并/单盒代理外扩);这些是 HLOD 盒代理的固有近似,门限未设、数值如实。
- 未折叠区成员 id 逐位一致(近档 378754 px 同 id)——折叠决策边界外的实例渲染与全量腿逐像素同 id。

### 2.2 轮廓对比 = 覆盖掩码差异像素计数(如实记录)

差异 = missRaw + overhang:近档 0+0;巡航 0+0;远档 0+1513;航拍 0+4。方向性:overhang 单向(B⊇A),无反向缺失。

### 2.3 时序 Hi-Z 帧内锚点(生产单源对拍)

远档全量腿冻结深度 → 生产 `HiZPyramid.encode`(reversedZ:false,conservative→max)→ 10 mip 逐级读回 vs 生产 CPU 孪生 `instanceVisibilityTwin.buildDepthPyramid`:**10/10 mip 逐位相等(maxAbsDiff=0)**。跨帧 previousHiZ×折叠交互留项(§1.2-③)。

### 2.4 T26 削减率复核(10k 场景)

计划层账目(生产 `hlodProxyDrawCost`,与 batch-benchmark.json 同源)在本次 fresh 运行中逐值复现:近 0.25×=23 代理/巡航 1×=1747/**远 4×=隐藏 10000+242 代理、逐代理 242 draw → 合批 1 draw(削减率 0.9959)**/航拍 64×=1 代理(根折叠,削减率公式值 0 为该档定义性结果)。真机佐证:242 活动代理之外 12896 个折叠态实例(隐藏成员+非活动代理)合计零像素(1e-6 缩放),折叠态实例表 13138 = 10000+3138 恒等。

## 3. 验收记录

- 真机 fresh×2:`evidence.json` / `evidence2.json` 均 PASS(9/9 门限),两次逐像素统计与 Hi-Z 结果逐值一致。
- 聚焦测试:`vitest run src/hlod + hlodClusterStream(.batchBench) + instanceVisibilityTwin + hiZPyramid + hiZOcclusionCulling` → **99 passed / 2 skipped**。
- tsc:`packages/deep-engine` `tsc --noEmit` **EXIT=0**。
- **基线漂移如实登记**:`src/webgpu/hlodProxyDrawBatch.test.ts` 在 import 期失败,原因 `rendererCapabilitySelfCheck: PbrRendererFeatures surface drift — uncovered keys [layeredMaterials]`——来自并行线路的**未提交**改动(deviceSession.ts/pbrRendererTypes.ts 在 git status 为 M),与本切片新增的 scripts/ 文件无关联;该漂移需由相应线路收口。

## 4. F2 行还剩什么(下一可执行动作)

1. **传输接线**(他人在途域,等主线程窗口):流送路径 `applyClusterPlan` 的代理 overlay 换合批 1 块+实例行;非流送路径用 `hlodProxyBatchInstances` 行替换逐代理实例。本 probe 的像素级证据(合批数学 = `T_draw·M_box`,§2.1 一致性)即接线等价性依据。
2. **gpu-pass:hlod-proxy 计时**:渲染侧拆独立 pass + `GpuTimer.beginPasses` 括夹,帧时窗口解禁后同机复测 draw 数/gpu-pass ms/帧时 p50/p95(batchBench realGpuChecklist 第 1/2/4 条)。
3. **跨帧时序 Hi-Z × 折叠交互**:相机 A→A 两帧 previousHiZ 发布/消费与折叠决策的联合对照(依赖 previousHiZ 跨帧提交路径,本 probe 离屏单帧未覆盖)。
4. **真实网格口径的全量腿**:本 probe 全量腿用真实 GLB accessor 包围盒(与夹具同源);全三角网格的内部空隙误差不在本口径,需 GLB 几何进浏览器后复测(可复用本 probe 骨架)。

## 5. 复现

```bash
cd packages/deep-engine
node scripts/f2HlodCullGpuTest.mjs                    # 写 test-output/f2-hlod-cull-20261002/evidence.json
F2_EVIDENCE_NAME=evidence2.json node scripts/f2HlodCullGpuTest.mjs   # fresh 第 2 次
```
