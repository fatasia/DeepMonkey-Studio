# 超越 Bevy / Babylon / Unity / UE 的极致优化方案（2026-09-21）

> 基于全网调研与自研现状分析。目标：Deep Engine 在 Web 端（Deep WebGPU）与 Native 双端，
> 功能一致、效果相当或更好、性能有实测提升的前提下，在选定维度形成对四大引擎的代差优势。
> 调研基准：Babylon 9.0（Frame Graph v1.0 + Clustered Lighting，2026-03）、Bevy 0.17（Solari GPU
> 光追 + GPU-driven rendering）、Unity 7（GPU Resident Drawer / Entities Graphics）、
> UE 5.6/6（Lumen HWRT、Nanite programmable rasterization 路线）、Chrome 149–150 WebGPU 新特性。

## 0. 结论总览

| 维度 | 对标水位 | 我们现状 | 判定 | 超越路径 |
|---|---|---|---|---|
| 多灯光照 | Babylon 9 Clustered（千灯实时） | 64-lane clustered + IES + PCSS 已闭环 | **持平偏上** | tile 自适应 + subgroup 构建加速 |
| 全局光照 | Lumen（HWRT）/ Solari | DDGI+SSR+surface cache 本轮接入产品循环 | **Web 端代差领先** | 视差校正 probe + 泄漏控制收口 |
| GPU-driven | Unity GPU Resident Drawer | meshlet culling/indirect 已接，实例级未 GPU 化 | **落后一档** | 实例级 GPU culling→LOD→draw 全链 |
| 虚拟几何 | Nanite / Bevy Virtual Geometry | 分页/驻留/last-good CPU 侧闭环 | **落后两档** | GPU feedback + 可见性 buffer 着色 |
| Frame Graph | Babylon FG v1.0（图编排） | transient alias + MRT 裁剪 + encoder group | **持平偏上** | Native 真多线程 encoder（Babylon 无此项） |
| 画质自适应 | 桌面引擎档位系统 | 双滞回+冷却+用户覆盖+有界遥测已闭环 | **Web 端领先** | shadow/residency 预算本轮已接，收尾实测 |
| 体积/雾/反射层级 | UE Lumen 反射层级 | SSR 六层锥追踪+可信度体系 | **持平** | 视差校正 probe + 平面反射补层级 |
| 阴影 | 桌面引擎 PCSS/级联 | 级联+PCSS+IES+atlas 复用 | **持平偏上** | 统一时域有效性收尾 |

战略判断：硬件光追（Lumen HWRT/Solari）在 WebGPU 上无普及路径，不作为对标战场；
**Web/Native 双端一致 + BIM/工业语义（稳定 ID、工程精度、像素级 2D/3D 融合）是四大引擎都不覆盖的正面战场**。

## 1. P0：实例级 GPU-driven 渲染（对标 Unity GPU Resident Drawer，超越点=双层 GPU-driven）

- 对标水位：Unity 把 instance 数据常驻 GPU，`BatchRendererGroup` 直接生成 draw command，CPU 释放；
  但 culling 仍可选 CPU/GPU 两态，且仅实例层（无 meshlet 二级）。
- 我们现状：meshlet 层 GPU culling→compact→indirect 已接产品（消费审计 R4/R9 闭环）；
  实例层仍 CPU 逐帧提交（OPT-01/03 已减 25% 上传字节）。
- 方案：
  1. 实例缓冲常驻（已有 residency uploader）+ GPU 实例剔除（frustum+occlusion，消费已有上一帧 Hi-Z）；
  2. compute 生成 compacted indirect draw args（meshlet 间接执行器已有，补实例→meshlet 二级级联）；
  3. CPU 每帧只更新脏实例（revision 已有），静态场景零 CPU 提交。
- 验收：10,000 实例场景 CPU 提交时间下降 ≥70%（P95），draw 不变或更少；选中/拾取/测量语义不降级。
- 工作量档位：大（依赖批次 C 的 I/O 预算与间接链稳定）。

## 2. P0：可见性 buffer 着色（对标 Nanite programmable rasterization）

- 对标水位：Nanite 的延迟材质路径——meshlet 光栅化只写 depth+material ID，全屏 pass 还原材质。
- 我们现状：forward+ clustered 为主，透明/薄片单独处理；无可见性 buffer。
- 方案：静态不透明几何走 visibility buffer（R32G32 uint：meshletID+primID），全屏 material pass
  复用现有材质参数池；动态/透明/骨骼保留 forward 路径；与 TAA/SSR/Hi-Z 共享深度。
- 验收：静态场景 GPU 帧时间下降（三角驱动力从"每像素材质"降为"深度+ID"）；视觉 SSIM 不降。
- 工作量档位：大；收益与 P0-1 叠加（无 over-shading）。

## 3. P0：WebGPU 新特性采用（领先窗口，Babylon/Three 尚未用）

- `TRANSIENT_ATTACHMENT`（Chrome 149+）：transient 渲染目标可零主存——与现有 RenderGraph
  transient 复用叠加，MRT 带宽与显存双降。设备探测+降级（不支持则回退当前池化路径）。
- Subgroups（WGSL）：Hi-Z reduce、cluster 构建、culling prefix-sum、DDGI probe 更新四类 compute
  换 subgroup 实现；探测 feature 可用时启用，CPU 参考实现已有对拍基线（R2 DCIR 三方哈希）。
- 验收：支持的设备上对应 kernel 实测加速 ≥30%；不支持的设备路径逐字节不变。
- 工作量档位：中。

## 4. P1：Native 多线程 command encoding（对标=无；Babylon FG 仅编排）

- 现状：Web encoder group 同线程多 encoder；Native executor 未并行（交接明确不得用 Promise 冒充）。
- 方案：复用确定性 scheduler，资源准备/依赖计算并行化，command encoding 按渲染图分组派发 executor
  线程，提交次序固定；错误取消与 device loss 保持确定性。
- 验收：4 核以上 CPU encoding 时间近线性下降；提交字节序跨跑逐位一致。
- 工作量档位：大（Native 核心竞争力，桌面客户端专属优势）。

## 5. P1：bindless / 纹理虚拟化收口（对标 Unity/UE 材质密度）

- 现状：材质参数池（packet-local）已减 bind group；纹理页驻留/逐出未做。
- 方案：分级启用——小场景保现状；大场景纹理数组 + `texture_2d_array` 索引化材质；
  Native 端 wgpu bindless（bindless 描述符特性按设备分级）；虚拟纹理页真实驻留/逐出接 residency。
- 验收：纹理密集场景 bind group 切换次数下降一个量级；页驻留峰值受控且可见性无损。
- 工作量档位：大。

## 6. P1：GI 收口为 Web 端代差（对标 Lumen 无 RT 的情形）

- 我们已是 Web 端唯一产品级 DDGI+surface cache+SSR 可信度体系（本轮 R1 接入后从"内核就绪"转为产品循环）。
- 收口清单：probe 视差校正（局部 probe）、DDGI 遮挡/泄漏控制增强、多灯接触阴影时域稳定、
  反射层级从 SSR→probe→环境的三级回退（执行计划批次 B-2/C2-6 既定）。
- 验收：GI-on 固定夹具 SSIM 保持 ≥0.99；复杂几何无泄漏伪影的人工双重盲评。
- 工作量档位：中（收口性质，无新基建）。

## 7. P2：光照与阴影微调（对标 Babylon 9 文档的已知弱点）

- Babylon 官方文档承认 tile 过小导致像素分支爆炸——我们做 tile 尺寸按场景灯密度自适应
  （一次 bake 选择 + 帧内 profiler 反馈重选），并保留确定性 overflow（已有）。
- 多灯接触阴影与 PCSS 统一时域可信度（已有体系，补局部灯项）。

## 8. P2：CPU 侧极致（编辑器启动与运行，见独立任务）

- 启动：代码分割按面板/引擎双入口、deep-engine 模块懒加载（bridge 已动态 import）、
  冻结场景首帧前禁非关键预热、服务预热结果缓存复用（ShaderPackageExecutor last-good 已有）。
- 运行：静态场景按变更驱动降频（批次 C-4）、事件唤醒矩阵（动画/物理/告警/视频/TAA/输入）。

## 9. 明确不做（诚实边界）

- 不做跨引擎跑分恢复（用户已取消）；官方资料只做设计校准；
- 不把 Web 端 DDGI 冒充"Lumen 级全动态 GI"——宣传口径限"Web 端产品级实时 GI"。

## 9.5 追平平台边界项（2026-09-21 用户指令：Lumen HWRT / Nanite 极限 / 原生多核）

### 9.5.1 硬件光追 → RayBackend 双实现（软件 BVH 先行，硬件即插即用）

- 差距本质：UE 用 DXR/Vulkan RT。WebGPU 无 RT API（提案推进中）；wgpu RT 实验性。
- **追赶路线**：
  1. 定义 `RayBackend` 合同（closestHit/anyHit/occlusion 查询，场景 BLAS/TLAS 句柄）；
  2. **软件实现**：WGSL compute 两级 BVH（BLAS 按 meshlet 分页缓存、TLAS 每帧重建——实例数工业场景 <10 万，重建成本可忽略）；先落地三个消费者：SSR 屏外反射射线（补 SSR 缺失）、局部光软阴影射线（PCSS atlas 到任意灯）、DDGI probe 遮挡验证；
  3. **硬件实现**：Native wgpu RT（experimental feature 探测）同合同接入；浏览器 WebGPU RT 提案落地后 Web 端同合同切换，零上层改动。
- 等效判据：BIM/工业室内场景，GI/反射/软阴影视觉等效 Lumen 非 HWRT 档（固定夹具 SSIM + 盲评）；开放世界大尺度不追（非目标负载域）。

### 9.5.2 Nanite 数十亿三角 → cluster LOD DAG + 可见性 buffer + 软光栅后备

- 差距本质：Nanite = cluster LOD DAG + 可见性 buffer + 微三角 compute 软光栅。
- 我们已有数据层+剔除层（meshlet 分页/内容寻址/Hi-Z/indirect）。
- **追赶路线**（依赖 P0-1 实例 GPU-driven、P0-2 可见性 buffer）：
  1. **cluster LOD DAG**：bake 期 cluster 简化层级（父子指针+误差标量，挂现有 author LOD/bake 管线）；GPU 端按屏幕误差阈值逐 cluster 选层（消费 Hi-Z 覆盖）；
  2. **软光栅后备**：compute scanline 光栅仅处理"选层后仍超误差阈值的 cluster"，写同一 visibility buffer（社区已有 WebGPU 先例，非理论）；CAD 高曲率边缘正需要它；
  3. **可验证目标**：单场景 10 亿级源三角（全楼 BIM 合并）、帧内可见 200–500 万三角 @60fps（RTX 4060 档），代替不可实测的"数十亿"营销口径。
- 诚实边界：像素级无瑕疵等价 Nanite 不承诺；验收=固定夹具 SSIM + 边缘锯齿度量 + 帧时间。

### 9.5.3 原生多核红利 → 双端分工

- **Native（wgpu）可全面追平**：真多线程 command encoder（P1-4）+ 专用渲染线程 + rayon 并行资源准备；wgpu 异步提交模型不落后于 D3D12。完成后架构位与 UE 渲染线程/RHI 线程等效。
- **Web 端等效体验路线**：JS 主线程是硬边界，但渲染 CPU 占比已实测 <10%（R6 结论），瓶颈不在提交。补两件事：
  1. CPU 密集离线工作全部 worker 化（几何 bake、纹理转码、场景编译——worker 基建已有）；
  2. 评估渲染循环迁入 OffscreenCanvas worker + SharedArrayBuffer（COOP/COEP 可控：桌面客户端与本地部署），主线程只剩输入与 UI——达到"交互永不卡顿"的体验等效。
- 验收：主线程长任务（>50ms）计数为 0；Native 端 encoding 线性度 ≥3.5x/4 核。

### 新增任务队列映射

1. RayBackend 合同 + 软件 BVH + SSR/软阴影/probe 三个消费者（P1，GI 收口的下一跳）；
2. cluster LOD DAG + 软光栅后备（P0-2 之后）；
3. Native 渲染线程架构（P1-4 扩展）+ Web 渲染 worker 隔离评估（独立立项）。

## 10. 排期与批次映射

1. P0-1/P0-2 归入批次 C2-1/2 的延续（依赖 GPU feedback、mega-buffer 未完成项收口）；
2. P0-3 可独立先行（双端探测+降级，风险低收益即时）；
3. P1-4 Native executor 归批次 C2-3；P1-5 归批次 C2-4；
4. P1-6 GI 收口归批次 B-2/C2-6；
5. 全部收益证据统一进批次 F（同场景同条件 CPU/GPU/显存 P50/P95/P99 + 对拍）。

## 附：调研来源

- [Announcing Babylon.js 9.0](https://blogs.windows.com) · [Babylon Clustered Lighting Docs](https://doc.babylonjs.com) · [Babylon Frame Graph v1.0](https://forum.babylonjs.com) · [FG 实现 PR #17294](https://github.com/BabylonJS/Babylon.js) · [Babylon 9.0 解读](https://www.arttechpost.com)
- [Bevy 0.17（Solari）](https://bevy.org/news/bevy-0-17) · [Bevy 0.16 GPU-driven rendering](https://bevy.org/news/bevy-0-16) · [Solari 博文](https://jms55.github.io/posts/2025-09-20-solari-bevy-0-17)
- [Unity GPU Resident Drawer（URP）](https://docs.unity3d.com) · [Entities Graphics+GPU RD 讨论](https://discussions.unity.com) · [Unity Graphics 仓库指南](https://github.com/Unity-Technologies/UnityGraphics)
- [UE 5.6 性能亮点](https://tomlooman.com) · [Lumen 官方指南](https://dev.epicgames.com) · [UE 5.6 35% 提升报道](https://www.techpowerup.com) · [Nanite 路线图](https://portal.productboard.com) · [UE 5.6 60FPS 深读](https://www.strayspark.studio)
- [Chrome 149–150 WebGPU 新特性](https://developer.chrome.com) · [WebGPU 规范](https://www.w3.org) · [WebGPU 工程实践](https://blog.4dpipeline.com) · [TSL/WebGPU 指南](https://blog.maximeheckel.com) · [Three.js 性能 100 招](https://www.utsubo.com)
