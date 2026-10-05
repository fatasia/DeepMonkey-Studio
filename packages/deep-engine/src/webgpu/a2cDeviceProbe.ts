/// <reference types="@webgpu/types" />
/**
 * a2c 设备级自证探针(A2C-P1 场景自适应判据的最终形态):
 * 不读用户场景——自绘 64×64 已知色图,解析判定与场景内容无关。
 *
 * == 判据 ==
 * 清屏背景 B=(0,1,0),几何四边形 G=(1,0,0) 以 alpha=0.5 经 **a2c 管线**绘制:
 * - 驱动按片元 alpha 生成采样掩码(规范语义)→ 像素 ≈ 0.5·G+0.5·B,r≈0.5 → effective;
 * - 驱动接受 descriptor 但不生成掩码(Dawn/D3D12 本机实证)→ 像素 = G,r≈1 → ineffective;
 * - 读数落在两界之间(非预期)→ inconclusive(fail-open,保持 a2c 交由场景探针)。
 *
 * 独立小管线(target0 rgba8unorm 单目标 MSAA4)与主 pass 管线矩阵零耦合——
 * A/B 实验已证掩码生成与 RT 位深/MRT 无关,单目标小图是忠实的设备级测试。
 * 一次性开销:64² 两次 draw+4KB 读回,ms 级。
 */

export type A2cDeviceProbeVerdict = "effective" | "ineffective" | "inconclusive";

const PROBE_SIZE = 64;
const GEOMETRY_R = 1.0; // 几何红
const BACKGROUND_R = 0.0; // 背景绿
/** 判据界:effective 融合 r≈0.5;ineffective 全画 r≈1;中间带非预期。 */
const EFFECTIVE_R_MAX = 0.75;
const INEFFECTIVE_R_MIN = 0.9;

/** 纯判定:中心像素 r 值 → 结论。单测锚点。 */
export function judgeAlphaToCoverageDevicePixel(r: number): A2cDeviceProbeVerdict {
  if (!Number.isFinite(r)) return "inconclusive";
  if (r <= EFFECTIVE_R_MAX) return "effective";
  if (r >= INEFFECTIVE_R_MIN) return "ineffective";
  return "inconclusive";
}

const PROBE_WGSL = /* wgsl */ `
struct VsOut { @builtin(position) clip: vec4f, @location(0) color: vec4f };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  // 全屏四边形(两三角形,strip 展开为 list 的 6 索引由调用方 draw(6) 供给)。
  var p = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  var out: VsOut;
  out.clip = vec4f(p[vi], 0.0, 1.0);
  out.color = vec4f(${GEOMETRY_R.toFixed(1)}, 0.0, 0.0, 0.5);
  return out;
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f { return in.color; }
`;

const USAGE_RT = 0x10; // RENDER_ATTACHMENT
const USAGE_COPY_SRC = 0x4;

/**
 * 设备级 a2c 有效性自证(一次性;读回失败/异常一律 inconclusive fail-open)。
 * 与主管线矩阵零耦合:自建 64×64 rgba8unorm MSAA4 目标+独立小管线。
 */
export async function probeAlphaToCoverageDevice(device: GPUDevice): Promise<A2cDeviceProbeVerdict> {
  const target = device.createTexture({ label: "a2c-device-probe-resolve", size: [PROBE_SIZE, PROBE_SIZE],
    format: "rgba8unorm", usage: USAGE_RT | USAGE_COPY_SRC });
  const msaa = device.createTexture({ label: "a2c-device-probe-msaa", size: [PROBE_SIZE, PROBE_SIZE],
    format: "rgba8unorm", sampleCount: 4, usage: USAGE_RT });
  const module = device.createShaderModule({ label: "a2c-device-probe", code: PROBE_WGSL });
  let pipeline: GPURenderPipeline;
  try {
    device.pushErrorScope("validation");
    // @webgpu/types 0.1.72 尚无 alphaToCoverageEnabled 字段(运行时/WebGPU 规范已有)——
    // 与 shadowRayPass 的 writeTimestamp 局部桥接同款:类型断言写入,运行时缺失会由
    // validation error scope fail-closed 捕获。
    const targetState = { format: "rgba8unorm" } as GPUColorTargetState &
      { alphaToCoverageEnabled?: boolean };
    targetState.alphaToCoverageEnabled = true;
    pipeline = device.createRenderPipeline({ label: "a2c-device-probe", layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [targetState] },
      multisample: { count: 4 },
      primitive: { topology: "triangle-list" } });
    const error = await device.popErrorScope();
    if (error) return "inconclusive";
  } catch {
    return "inconclusive";
  }
  try {
    const encoder = device.createCommandEncoder({ label: "a2c-device-probe" });
    const pass = encoder.beginRenderPass({ label: "a2c-device-probe",
      colorAttachments: [{ view: msaa.createView(), resolveTarget: target.createView(),
        clearValue: { r: BACKGROUND_R, g: 1, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
    pass.setPipeline(pipeline);
    pass.draw(6);
    pass.end();
    device.queue.submit([encoder.finish()]);

    // 读回中心 2×2,逐像素判定后取多数(排除边缘过滤噪声)。
    const bytesPerRow = Math.max(256, PROBE_SIZE * 4);
    const readback = device.createBuffer({ label: "a2c-device-probe-readback",
      size: bytesPerRow * PROBE_SIZE, usage: USAGE_COPY_SRC | 0x1 /* MAP_READ */ });
    const copy = device.createCommandEncoder({ label: "a2c-device-probe-copy" });
    copy.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow,
      rowsPerImage: PROBE_SIZE }, [PROBE_SIZE, PROBE_SIZE]);
    device.queue.submit([copy.finish()]);
    await readback.mapAsync(0x1 /* MAP_READ */);
    const data = new Uint8Array(readback.getMappedRange());
    const verdicts: A2cDeviceProbeVerdict[] = [];
    for (const [px, py] of [[PROBE_SIZE / 2 - 1, PROBE_SIZE / 2 - 1], [PROBE_SIZE / 2, PROBE_SIZE / 2],
      [PROBE_SIZE / 2 - 2, PROBE_SIZE / 2], [PROBE_SIZE / 2, PROBE_SIZE / 2 - 2]] as const) {
      verdicts.push(judgeAlphaToCoverageDevicePixel(data[(py! * bytesPerRow + px! * 4)]! / 255));
    }
    readback.unmap();
    readback.destroy(); msaa.destroy(); target.destroy();
    const effective = verdicts.filter(v => v === "effective").length;
    const ineffective = verdicts.filter(v => v === "ineffective").length;
    if (effective >= 3) return "effective";
    if (ineffective >= 3) return "ineffective";
    return "inconclusive";
  } catch {
    return "inconclusive";
  }
}
