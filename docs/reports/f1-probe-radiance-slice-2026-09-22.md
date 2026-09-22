# F1 探针一跳场景辐射切片交付报告（2026-09-22）

范围：交接文档 F1"动态 GI 与探针真实辐射"的前两个切片 + 产品工厂合同钉测。
提交：`ae1bc73`（切片1 生产者与产品接线）、`0a0a47d`（切片2 环境均值读回）、`c8bca54`（工厂合同单测）。

## 交付内容

### 切片 1：`encodeSourceRadiance` 首个真实 GPU 生产者

| 组件 | 文件 | 职责 |
|---|---|---|
| 一跳着色内核 | `packages/deep-engine/src/rayTracing/probeRadianceKernel.ts` | 两级 TLAS→BLAS 软件遍历（复用 RayBackend 共享 WGSL 片段，sha256 钉死合同零触碰），命中点 Lambert 着色 `albedo × NdotL × 直射光 / π`，miss 记环境项，Fibonacci 确定性方向集 ≤16/探针（与 `probeOcclusionDirection` 同式），原子溢出哨兵 fail-closed |
| 场景辐射生产者 | `packages/deep-engine/src/rayTracing/probeSceneRadianceProducer.ts` | RenderPacket → `buildRenderPacketRayScene` → `packTlasScene` 持久上传；逐帧主光锁存；每事务一次 dispatch、按 generation 幂等；形变/全透明包软降级（记录 reason、捕获拒绝、渲染循环不中断）；零能量输入拒绝捕获（保持 IBL，禁止黑色体积） |
| 产品接线 | `pbrRenderer.createProbeClipmapController` + `ProbeClipmapPbrControllerOptions.sceneRadianceSync` | 实现 `DeepWebGpuRenderRuntime` 产品 GI 工厂：`backend.setProbeClipmapEnabled(true)` 现在产生 `radianceSource=scene` 的真实宿主控制器（此前全仓无人传 `options.probeClipmap`、工厂未实现，宿主恒为 `unavailable`+IBL） |

### 切片 2：环境均值 GPU 读回

`packages/deep-engine/src/webgpu/environmentAmbientReader.ts`：对内置 studio IBL 的漫射辐度 cubemap 做确定性稀疏均值（6 面 × 8×8 方向，`textureSampleLevel` 采 mip0），384 样本 GPU 写出 + CPU RGB 归约；PbrRenderer 按环境身份缓存并馈送探针 ambient。

## 真机证据（headless Chrome + 真 WebGPU，`node scripts/probeRadianceGpuTest.mjs`）

证据目录：`test-output/probe-radiance-gpu-20260922/report.json`（含原始 f16 读回与 WGSL）。**Gate TRUE**：

| 断言 | 结果 |
|---|---|
| 三探针 CPU 逐值对拍（同 bundle CPU 参考：`traceTlasClosest` + 同公式） | 全过：open-sky / above-box 绝对差 ≤2e-4；occluded 在"单方向翻转界"内（见下） |
| 场景遮挡方向性 | 开阔天空探针能量 > 遮挡探针 ✓ |
| 一跳能量存在 | ✓ |
| 环境均值读回 | studio IBL 实测 RGB [0.525, 0.563, 0.613]；双读 repeatDelta 逐位 0（确定性） |
| 栈溢出哨兵 | 0（全部遍历完成） |
| WGSL 编译诊断 | 0 告警 |

单方向翻转界说明：探针贴近几何时必有掠射方向落在 f32/f64 舍入边界上（CPU 记 miss、GPU 记零贡献侧面命中，或反向），单个翻转对均值的贡献恰为 `maxHitRadiance / directionCount`（本夹具实测差值 = ambient/8，逐通道吻合已归因）。门禁按该物理界放行并记录 `flipAllowance`，非掠射探针仍按 2e-4 精确对拍钉住内核正确性。

## 回归门禁

- 单测：`probeSceneRadianceProducer.test.ts` 9/9（打包黄金布局、stub 设备编码语义、批次幂等、fail-closed 边界）；`environmentAmbientReader.test.ts` 3/3；`pbrRendererProbeFactory.test.ts` 钉死产品工厂 `radianceSource=scene`。
- 聚焦回归：探针族 51/51、threeBridge 会话 16/16、门禁合集 27/27。
- typecheck：deep-engine 与 apps/web 均绿；`quality:source-size` 5955 文件全过。

## 边界（诚实条款）

- 命中点不追第二次阴影射线（一跳直射估计）；MASK 纹理 alpha / BLEND / 动态形变按 `RenderPacketRayScene` 既有排除与拒绝口径。
- 环境均值是稀疏采样（384 方向），不是全积分；对低频 IBL 足够，高频环境会欠采样。
- 动态脏区更新、2–4 次受限历史反馈、能量钳制、泄漏与收敛诊断仍为 F1 待办（调度器 dirty/dynamic 通道与滞后混合已有，但生产场景收敛证据未采集）。
- 真 Studio 页面级验收（真实项目场景开启 GI 后的画面对拍）留待集中验收阶段。
