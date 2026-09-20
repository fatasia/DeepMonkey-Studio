# bindless / 纹理虚拟化分级落地任务卡（波次5，2026-09-21）

> 供子代理直接执行。现状盘点 2026-09-21 主线程走查，路径可追溯。

## 现状（已核实）

| 组件 | 状态 | 位置 |
|---|---|---|
| Web 材质参数池 | ✅ packet-local 去重（40 float/160B 参数 + immutable texture uniform bind group 复用，hits/misses 遥测） | `webgpu/materialBindings.ts`（MaterialBindingPool，201 行） |
| Web 纹理资源 | ✅ 常规 per-material bind group；无 texture_2d_array/bindless | `webgpu/textureResources.ts` |
| Native 材质布局 | ✅ wgpu `material_layout`/`frame_layout` 常规绑定 | `deep-engine-native/src/renderer.rs:88` |
| Native 纹理域 | ✅ gpu_textures/gpu_texture_upload/pbr_texture 独立域 | `deep-engine-native/src/` |
| residency 基础 | ✅ GpuResidencyRuntime/SceneChunkResidency（几何已有页级驻留/逐出） | `webgpu/gpuResidencyRuntime.ts` 等 |
| **纹理数组化** | ❌ 无 | 本卡 |
| **虚拟纹理页驻留/逐出** | ❌ 无 | 本卡 |

## 分级路线（按调研文档 P1-5，逐级独立可验）

### 级 1：同格式纹理数组（texture_2d_array）
- Web：按（格式×尺寸档）把场景纹理聚入 `texture_2d_array`，材质 uniform 存数组索引；
 采样 shader 改 `textureSampleLevel(t[saveIndex], …)`——**采样代码路径双轨**（数组开关 on/off 同一 WGSL 分支或两份 pipeline），默认关。
- 边界：数组层上限按设备 `maxTextureArrayLayers` fail-closed；超限回退常规路径并计数。

### 级 2：Native wgpu 对等
- `texture_array` 等价能力在 wgpu 常规 API 即可（无需 bindless extension）；与 Web 同合同。

### 级 3：虚拟纹理页驻留/逐出
- 页表（页尺寸 128/256）+ residency 控制器对接既有 GpuResidencyRuntime 语义；页粒度 KSample 不可行处的 mit 坑（页边界反馈环）如出现，记录并限制页更新频率。
- 级 3 视级 1/2 落地收益再启动，本卡只要求级 1/2。

## 测试与验收
- 级 1：数组化打包 roundtrip、索引越界 fail-closed、默认关零变化（shader 字符串不含数组采样）、超限回退计数；
- 级 2：Native focused cargo test 对齐同一索引合同（identityGolden 模式：同输入索引一致）；
- 双端 typecheck/cargo 全过；真机渲染证据归批次 F。

## 边界（诚实）
- 不做 wgpu bindless extension（绑定量上限按设备分层已足够第一性收益）；
- 不承诺数组化对带宽的量化收益（归批次 F 实测）。
