/**
 * Native wgpu 第三端 harness 合同(R2 切片 2 2026-09-19:**已接**,证据见
 * `test-output/r2-native-third-end-20260919-r1/evidence.json`)。
 *
 * 实装:packages/deep-engine-native/tests/r2_shader_compute_harness.rs(真机 GPU 显式运行):
 * `cargo test -p deep-engine-native --test r2_shader_compute_harness -- --ignored --nocapture`
 *
 * - WGSL 文本 = `emitKernelWgsl(kernel).code` 原样写入
 *   `packages/deep-engine-native/assets/shaders/dcir_hi_z_*.wgsl`(4 工件,测试内
 *   sha256 断言与 R2/R4 evidence 工件哈希一致,防复制漂移;R2 与 R4 的 anchored
 *   工件同哈希已验证);
 * - Rust 侧(wgpu 30,装配方式同既有 GPU 测试):r32float 源纹理
 *   (TEXTURE_BINDING | COPY_DST,行 256 对齐上传)、r32float 目标纹理
 *   (STORAGE_BINDING | COPY_SRC)、dispatch ceil(tw/8)×ceil(th/8)、
 *   copy_texture_to_buffer(行 256 对齐)读回去填充;
 * - **uniform 实际 16 字节**:uvec2 sourceSize @0 + uvec2 targetSize @8。早期
 *   "32 字节(u32 reduceMax @16)"设计已废弃——reduceMax 在 IR 层特化为 min/max
 *   双工件(ANGLE/D3D11 uniform 打包 quirk 的规避,R2 真机结论);
 * - 认证结论:非 denormal 案例逐位档通过——R2 单级 5 案例(4 bitwise + 1 denormal 探针)
 *   + R4 全链 10 案例 46 级(anchored/variable 双内核逐级,含 2 个 perf 链)Native wgpu
 *   输出哈希与 Web 端 WebGPU(Dawn)证据逐位一致,同端两轮重复稳定,两次完整运行
 *   51 份 dump 逐字节一致;denormal 案例为阈值档探针(FTZ 风险,设计 §4.4),Native
 *   与 Web 端逐位一致(同 NVIDIA 驱动栈,FTZ 行为一致)已在 evidence.json `denormal`
 *   字段如实记录;
 * - 性能:单 encoder timestamp 包夹,`queue.get_timestamp_period()` 校准绝对 ns,
 *   与 Web 端 Dawn ratio 口径分开(见 evidence.json `perf`)。
 */
export const NATIVE_WGPU_HARNESS_STATUS = "connected" as const;
export interface NativeWgpuHarnessContract {
  readonly kernelName: string;
  readonly wgslArtifact: string;
  readonly uniformBufferBytes: 16;
  readonly readbackBytesPerRowAlignment: 256;
  readonly determinismTier: "bitwise" | "tolerance";
}
