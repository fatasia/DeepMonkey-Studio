/**
 * Native wgpu 第三端 harness 合同（R2 切片 2026-09-19：**未接**，如实声明）。
 *
 * 本切片只交付 Web 端双后端（WebGPU/WGSL + WebGL2/GLSL）的真机对拍；Native 侧路径如下，
 * 启动时无需改动本模块，只需在 deep-engine-native 侧新增集成测试：
 *
 * 1. `emitKernelWgsl(kernel).code` 的文本原样写入
 *    `packages/deep-engine-native/assets/shaders/r2_hiz_first_stage_v1.wgsl`（或测试内联字符串）；
 * 2. Rust 侧（wgpu 30，现有 GPU 测试基建同 `src/gpu_culling.rs` 的管线装配方式）：
 *    - 创建 r32float 源纹理（COPY_DST | TEXTURE_BINDING），按行 256 对齐 writeTexture；
 *    - 目标 r32float 纹理（STORAGE_BINDING | COPY_SRC），uniform buffer 32 字节
 *      （uvec2 sourceSize @0、uvec2 targetSize @8、u32 reduceMax @16）；
 *    - dispatch ceil(tw/8)×ceil(th/8)，copy_texture_to_buffer（bytesPerRow=256 对齐），
 *      map_async 读回并去除行填充；
 * 3. 输出按原始字节 sha256 与本车道 `test-output/r2-shader-ir-20260919-r1/evidence.json`
 *    的 Web 端哈希对拍；逐位档判定口径与设计 §4 一致；
 * 4. 与其他 Native 车道共享 cargo target 锁，运行前必须错峰（等待并行测试结束）。
 *
 * 时间不够未实现的部分：上述 Rust harness、三端 evidence.json 汇总。不存在任何
 * "Native 已验证"的替代声明；在 harness 落地前，Native 端仅享有"同一 WGSL 文本"这一承诺。
 */
export const NATIVE_WGPU_HARNESS_STATUS = "not-connected" as const;
export interface NativeWgpuHarnessContract {
  readonly kernelName: string;
  readonly wgslArtifact: string;
  readonly uniformBufferBytes: 32;
  readonly readbackBytesPerRowAlignment: 256;
  readonly determinismTier: "bitwise" | "tolerance";
}
