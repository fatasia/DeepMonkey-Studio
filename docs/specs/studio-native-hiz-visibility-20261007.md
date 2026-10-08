# Native/WASM 基础体可见性

修复生产 WASM 中底座可见、立柱和热点本体消失的问题，保留默认遮挡剔除。

## 现状核查

1. 已查 packages/apps 源码与未跟踪文件：作者三基础体经 sceneSnapshotToRenderPacket 使用同一 Three 几何生成器；Native 主色 pass 消费 GpuCulling 主视 indirect，阴影独立消费其级联视锥。没有缺圆柱/球生成器。
2. contracts PrimitiveKind 已含 sphere/cylinder；Native GeometryResource/RenderPacket 只收通用顶点、索引与材质，图元类型不参与绘制。无需新增合同。
3. Three、wgpu 与 DCIR max/min HiZ 内核均已有；max 两份已认证工件在 Native assets，复用既有内核。
4. renderer/init 默认 auto→HiZPyramid→GpuOcclusion→compact→draw_solid_indirect；阴影不受主视遮挡。现生产链使用标准 Z 的 min 缩减，再以足迹内 min 判整物体遮挡；NDC Y 也未转纹理坐标。
5. hi_z_pyramid_tests、gpu_occlusion_tests 已有尺寸、变窗与 GPU 恒定深度证据；恒定深度无法发现部分遮挡误剔。真实场景 78e 三对象 visible=true/opacity=1，正缩放/单面；user78e-wasm-production-final.png 只有底座与柱阴影，新旧 WASM 均复现。
6. 已查 Native HiZ/质量规格、handoff 与 recovery ledger。默认遮挡须保守保留，不通过关闭能力掩盖；当前 GPU/Cargo 独占性能排查，先 CPU 实现与反例，后串行真机。

**已有（不重建）**：全部基础体几何、材质/阴影、GPU 主视剔除、HiZ、已认证 DCIR max 缩减核与对应测试框架。

**真实缺口**：标准 Z 完整覆盖需要足迹最远深度，原 min 只证明局部遮挡；MSAA 部分覆盖与 Y 翻转也需保守一致。补 max 全链及部分覆盖/投影方向的真实数学反例；最终通过生产 WASM 同场景视觉复查。

## 当前验证

复用两份既有 DCIR max 内核；4x MSAA 提取与足迹判定均使用最远值。纹理 Y 翻转，透视球足迹按近/远分母区间包围；剪切变换半径使用矩阵范数上界。工作上限保持，超出时保留完整物体，不截掉足迹一半继续判遮挡。

`node --test scripts/native-hiz-visibility.test.mjs` 三项通过：用已有 TS 权威 visibility/AABB 证明部分遮挡误剔、Y 方向和偏轴球原近似的真实漏包围点；对应正式 shader 与 max 消费接线受检查。

Rust bin 编译通过（1m16s、-j2），HiZ CPU 5 tests 通过。RTX 4060 Vulkan 三个实际 GPU 用例通过：真实 4x 深度→max 金字塔→完整遮挡消费（0.79s），部分遮挡远平面 texel 保留实例（0.21s），奇数尺寸 variable max 缩减逐位对 CPU（0.21s）。时间包含用例设备初始化与 readback，不作帧性能定标。日志为 `test-output/studio-native-hiz-cpu.log` 和 `studio-native-hiz-gpu-{production,partial,variable}.log`。

主线程整构建后的生产 WASM 已由引擎切换任务复查同一 78e 场景：`data-backend=deep-wasm`、WASM canvas opacity=1，作者和 Deep GPU canvas opacity=0；底座、立柱、球形热点全部可见。证据：`test-output/studio-engine-lod-switch-20261007/user78e-wasm-hiz-final.png`。默认遮挡保持开启；此项完成。最终 Native 0.2.0 静态 CRT 发行包仍需使用本轮源码重新构建。
