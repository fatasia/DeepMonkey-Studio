# 性能优化与功能补足方案分析（2026-09-25）

## 现状核查

1. **已有能力，不重建**：`FramePerformanceMonitor`、`EnginePerformanceTelemetry`、`MainThreadLongTaskMonitor` 只作为验证工具；Deep 已有 RenderPacket、meshlet/Hi-Z/indirect、GPU 驻留、`ResidencyStreamScheduler`、运行包校验、LKG 回退和多后端桥。
2. **已有消费方**：WebGPU/WASM/Native 已消费 RenderPacket；发布链已有 `standard/fast` 档位和 degraded/blocked 语义。
3. **真实性能缺口**：Three 场景遍历与 Deep 路径仍可能重复；首轮 shader/资源上传存在拖尾；GPU completion 队列与输入提交延迟仍未完全收敛；实例级剔除还未完全 GPU 化。
4. **真实功能缺口**：Deep 纯编辑的输入/拾取/gizmo/作者态仍有边界；Native 视频控制、音频和 seek 未完全闭环；烘焙结果的 WASM/Native 消费需补齐；Native 导航的三角碰撞、坡度、步高、重力和 first/third person 仍需真实窗口证据。

## 直接性能优化

### P0：彻底切断 Three 重复遍历

把场景编译、材质快照、层级变换、骨骼姿态和拾取映射统一从 RenderPacket 消费；Three 只保留兼容回退。已有 `authorRenderPacket`、`objectBindings` 和 Deep bridge 可复用。

收益是减少每帧对象树遍历、矩阵同步、材质 setter 和 GC，直接针对当前 WebGPU input→submit 拖尾。验收比较同一场景的 CPU frame、pointer→submit、submit gap、GC 次数和 SSIM。

### P0：首帧与高质量补齐分阶段

首帧只上传可见闭包和最低 LOD，shader/pipeline 预热与远处资源后台补齐；复用 `AssetReimportCoordinator`、`ResidencyStreamScheduler` 和 last-good 资源，不引入新缓存格式。

验收：首个可交互帧、首个稳定质量帧分别测 P50/P95；上传尖峰受控；取消或设备丢失后无悬挂句柄。

### P1：实例级 GPU-driven，再做 visibility buffer

实例缓冲常驻 GPU，compute 完成 frustum+Hi-Z 剔除并生成 compact indirect args；静态不透明几何再切 visibility buffer，动态、透明和骨骼继续走 forward 路径。顺序不能反，否则无法归因收益。

验收：10,000 实例场景 CPU 提交 P95 下降至少 70%，draw calls 不增加，拾取/测量/轮廓仍能恢复作者 ID，SSIM 不低于基线。

### P1：预测性驻留与世界分区预取

把相机速度、转向、当前 LOD 接入现有驻留调度：预取下一视锥高概率 chunk，急转时撤销低概率任务，静止时降频；大世界沿已有 dynamic rebase 和 meshlet 分页扩展分区环形优先级。

验收：快速转身无 >100ms 资源爆点；驻留峰值有上限；取消后旧句柄全部归还。

### P2：CPU 与提交路径瘦身

几何 bake、纹理转码、场景编译继续放 worker；React 页面按稳定对象 ID 做增量更新，避免编辑单个对象导致整棵对象树重渲染；Native 再做固定顺序的资源准备和 command encoding 并行化。

## 功能补足

### F0：Deep 纯编辑闭环

将 Deep 的输入、拾取、gizmo、相机和对象选择接到现有中立命令层。当前 Three 仍掌控的路径逐项替换，无映射时明确回退。验收：同一对象可在 WebGL/WebGPU/WASM 中选择、移动、旋转、缩放、撤销、保存、重开。

### F0：媒体控制完整化

Native 已有静音解码和合成，补正式窗口控制条、seek、音频输出、默认设备和音画同步；复用现有 Media Foundation/rodio 链，不另引入解码器。Web、WASM、Native 共享播放状态合同。

### F1：烘焙结果端到端消费

已有 probe bake 持久化和 Web 消费，补 WASM/Native runtime package 消费、回填来源标记、失配回退和发布一致性检查。必须验证保存→刷新→重开→发布→公开读取。

### F1：Native 导航真实消费

补齐三角碰撞、坡度/步高、重力、跳跃和 first/third person 的真实窗口消费。当前数学模块和输入状态只能算底座；发布预检继续 fail-closed，直到真实 Native 场景证实。

### F2：跨端工程语义一致

设备状态、告警、测量、剖切、物理事件和数据绑定统一映射到稳定对象 ID；对象树、3D、2D 图表和发布查看器共享 selection context。优先补“告警→定位→动作→回放”。

## 推荐顺序

1. RenderPacket 脱离 Three 重复遍历。
2. 首帧/后台补齐与 GPU completion 拖尾优化。
3. Deep 纯编辑闭环。
4. 实例级 GPU-driven 与预测性驻留。
5. 烘焙跨端消费、媒体控制、Native 导航。

## 不建议现在做

- 不新建第二套性能监控、缓存、运行包或发布格式。
- 不用局部单球、CPU submit 或静态截图宣称全面超过 Three/Unity/Bevy。
- 不先做复杂光追、完整 Nanite 软光栅或大型 UI 重构；先消除真实重复工作和已确认功能缺口。

## 统一验收

固定场景、相机、输入轨迹下同时记录首帧、稳定质量帧、输入到呈现延迟、CPU/GPU P50/P95/P99、上传 bytes、驻留峰值、内存、设备恢复和 SSIM。缺项标记为 partial，不推导胜出结论。

## 实施进度记录(2026-09-26 凌晨批次追加,以下为已落地的实测,非计划)

### P0-1 切断 Three 重复遍历:已完成第一刀(webgpu 独立包路径)
- 改动:`viewerFramePresentation.ts` 在 WebGPU 独立 RenderPacket 路径(authorRenderPacket 编译成功)下
  跳过每帧作者场景 `updateMatrixWorld` + LOD 全景遍历;`viewerEngineRuntime` 新增
  `setAuthorPacketIndependent` 协议;`StudioDeepWebGpuBridge` 三处路径切换点同步通知;legacy 投影路径
  保持原遍历(兼容回退)。新增 2 个测试锁定行为(13/13 通过)。
- 验收(同场景同相机同输入轨迹三后端配对,`test-output/deep-fair-comparison-p0-cut1-20260925/`):
  **passed**;AB 对照(stash 改动跑同脚本 `deep-fair-comparison-p0-baseline-20260925/`):
  WebGPU 静置 P95 **13.8ms → 7.2ms(-48%,追平 WebGL 7.2)**,Long Task 10→6,输入 P95 14.1→14.2ms(持平),
  黑帧 0,位姿守卫无失败。
- 未动项如实:submit P95 受 backpressure 机制主导(专用变体处理),本刀不针对它;
  legacy 投影路径的尾随 sync 全量遍历仍在(需编辑态增量传播改造,属下一刀)。

### 附带:Plant 仿真内核 DES 吞吐优化(统一验收口径外,同法 AB 实测)
- 同输入同 seed,黄金指纹锁定,行为逐位一致(完工件数 8165/4200/1445/300 前后相等):
  - 60 工位大模型:1,956 → **32,280 events/s(16.5×)**,墙钟中位 255.6s → 15.5s;
  - 小单线 318k→795k(2.5×)、换型 278k→666k(2.4×)、多 AGV 56k→178k(3.2×)。
- 手段:Runtime 模型级预计算索引(节点/资源 O(1) 查找、有效产能/资源需求/班次并集启动期一次推导),
  消除每事件 linear-find 与全量过滤;数据 `test-output/plant-lite-bench-20260925.json`(before)、
  `plant-lite-bench-after-20260925.json`(after)。

### 下一批(按本文档推荐顺序)
- P0-2 首帧与高质量补齐分阶段(可见闭包+最低 LOD 优先、shader 预热)。
- legacy 投影路径的增量编辑传播(砍掉尾随全量 sync)。
- Deep 纯编辑闭环(F0)。

