import {
  GPU_PARTICLE_INDIRECT_BYTES, GPU_PARTICLE_STRIDE, GpuParticleRuntime,
  compileGpuParticleEmitters, submitGpuParticleEmitterFrame,
  type DeviceSession, type GpuParticleRenderBinding, type GpuParticleSeed,
} from "@bim-studio/deep-engine/webgpu";
import { PbrParticlePass, type ParticlePassCamera } from "../src/webgpu/pbrParticlePass.js";
import { runResourceCleanup } from "../src/webgpu/resourceCleanup.js";

export interface GpuParticleProbeResult {
  readonly action: "gpu-particles";
  readonly success: boolean;
  readonly aliveCount: number;
  readonly indirectCount: number;
  readonly presetsVerified: boolean;
  readonly timeContinuous: boolean;
  readonly burstCount: number;
  readonly burstBudgetDegraded: boolean;
  readonly expiredParticleRemoved: boolean;
  readonly failureRetainedActive: boolean;
  /** A4 真机渲染证据：alarm-pulse 专属取景离屏绘制后的非背景像素数；undefined 表示未执行。 */
  readonly renderedNonBackgroundPixels?: number;
  /** A4 扩展：expanding-ring 专属取景离屏绘制后的非背景像素数；undefined 表示未执行。 */
  readonly expandingRingRenderedNonBackgroundPixels?: number;
  /** A4 扩展：flow-line 专属取景离屏绘制后的非背景像素数；undefined 表示未执行。 */
  readonly flowLineRenderedNonBackgroundPixels?: number;
}

interface ReadParticle { readonly position: readonly number[]; readonly age: number; readonly id: number }

/** Real GPU preset simulation, lifetime wrapping, expiration, indirect count and rollback readback. */
export async function runGpuParticleProbe(session: DeviceSession): Promise<GpuParticleProbeResult> {
  if (session.state !== "ready") throw new Error("GPU particle probe requires a ready session.");
  const program = compileGpuParticleEmitters([
    { id: "alarm", preset: "alarm-pulse", position: [0, 2, 0], lifetime: 1, seed: 11 },
    { id: "ring", preset: "expanding-ring", center: [10, 0, 0], innerRadius: 1,
      outerRadius: 5, lifetime: 1, count: 4, seed: 22 },
    { id: "flow", preset: "flow-line", start: [20, 0, 0], end: [24, 4, 0],
      lifetime: 1, count: 4, seed: 33 },
  ], 16);
  const expired: GpuParticleSeed = { id: 99, position: [0, 0, 0], velocity: [0, 0, 0],
    age: 0.9, lifetime: 1 };
  const runtime = new GpuParticleRuntime(session, "lab-particle-presets-1",
    { capacity: 16, initialParticles: [...program.particles, expired],
      burst: { maxEvents: 2, particleBudget: 4 } });
  const stateBytes = runtime.capacityEvidence.capacity * GPU_PARTICLE_STRIDE;
  let readback: GPUBuffer | undefined;
  let binding: GpuParticleRenderBinding | undefined;
  try {
    const deltaTime = 0.25;
    const spawned = await runtime.beginFrame({ deltaTime, acceleration: [0, 0, 0], drag: 0, bursts: [
      { id: "probe-burst", position: [-5, 0, 0], direction: [0, 1, 0], count: 6,
        lifetime: 1, speed: 4, spread: 0, seed: 44 },
    ] });
    if (spawned.status !== "committed") {
      const detail = spawned.error instanceof Error ? spawned.error.message : String(spawned.error);
      throw new Error(`GPU particle burst frame did not commit (${spawned.status}): ${detail}`);
    }
    const burstBudgetDegraded = spawned.snapshot?.burstEvidence?.submittedParticleCount === 4
      && spawned.snapshot.burstEvidence.degraded;
    const moved = await submitGpuParticleEmitterFrame(runtime, { deltaTime });
    binding = moved.snapshot?.binding;
    if (moved.status !== "committed" || !binding) throw new Error("GPU particle frame did not commit.");
    const beforeFailure = runtime.current;
    const failed = await runtime.beginFrame({ deltaTime: Number.NaN });
    const failureRetainedActive = failed.status === "failed" && runtime.current === beforeFailure
      && failed.snapshot === beforeFailure;
    readback = session.own(session.device.createBuffer({ label: "Deep GPU particle probe readback",
      size: stateBytes + GPU_PARTICLE_INDIRECT_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    const encoder = session.device.createCommandEncoder({ label: "Deep GPU particle probe readback" });
    encoder.copyBufferToBuffer(binding.stateBuffer, 0, readback, 0, stateBytes);
    encoder.copyBufferToBuffer(binding.indirectBuffer, 0, readback, stateBytes, GPU_PARTICLE_INDIRECT_BYTES);
    session.device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const copied = readback.getMappedRange().slice(0), floats = new Float32Array(copied, 0, stateBytes / 4);
    const indirect = new Uint32Array(copied, stateBytes, GPU_PARTICLE_INDIRECT_BYTES / 4);
    const aliveCount = Math.min(indirect[1]!, runtime.capacityEvidence.capacity);
    const particles = Array.from({ length: aliveCount }, (_, index): ReadParticle => {
      const base = index * GPU_PARTICLE_STRIDE / 4;
      return { position: [floats[base]!, floats[base + 1]!, floats[base + 2]!],
        age: floats[base + 3]!, id: Math.round(floats[base + 14]!) };
    });
    readback.unmap();
    const presetsVerified = program.evidence.emitterCounts.alarm === 1
      && program.evidence.emitterCounts.ring === 4 && program.evidence.emitterCounts.flow === 4
      && program.particles.every(seed => matchesExpected(particles, seed, deltaTime * 2));
    const wrapped = program.particles.filter(seed => (seed.age ?? 0) + deltaTime * 2 >= seed.lifetime);
    const timeContinuous = wrapped.length > 0
      && wrapped.every(seed => matchesExpected(particles, seed, deltaTime * 2));
    const burstParticles = particles.filter(particle => particle.id >= 0x00800000);
    const burstCount = burstParticles.length;
    const burstVerified = burstCount === 4 && burstParticles.every(particle =>
      Math.abs(particle.position[0]! + 5) < 1e-4 && Math.abs(particle.position[1]! - 1) < 1e-4
      && Math.abs(particle.position[2]!) < 1e-4 && Math.abs(particle.age - deltaTime) < 1e-4);
    const expiredParticleRemoved = !particles.some(particle => particle.id === 99);
    const expectedAlive = program.particles.length + 4;

    // A4 多预设渲染证据：产品 PbrParticlePass 走 drawIndirect 一次绘制全部活粒子，CPU
    // 无法按发射器筛实例，因此按预设各自专属取景——把该预设区域映射进视口中心、把其余
    // 预设与爆发粒子推出 NDC（|x|>1 或 |y|>1 被裁剪），像素统计即可归属到单一预设。
    // 渲染时刻（两步 0.25s 模拟后）粒子位置由发射器公式+寿命回卷确定：alarm 在 (0,2)；
    // ring 四粒子极径 3.31/4.38/1.29/2.45（中心 (10,0)，XZ 平面，y 恒 0）；flow 四粒子
    // 在线段 x∈[20.03,23.18]、y∈[0.03,3.18]；爆发粒子在 (-5,1)。
    let renderedNonBackgroundPixels: number | undefined;
    let expandingRingRenderedNonBackgroundPixels: number | undefined;
    let flowLineRenderedNonBackgroundPixels: number | undefined;
    const pass = new PbrParticlePass(session, "rgba8unorm", "depth24plus");
    try {
      // alarm：scale 1 以 (0,2) 为中心，billboard 半径 0.25 → NDC 0.25；ring 最近 x≈8.66、
      // flow 最近 x≈19.98、爆发 x=-5，全部远超 1 被裁剪。
      renderedNonBackgroundPixels = await renderPresetNonBackgroundPixels(session, pass, binding,
        orthoEvidenceCamera(1, [0, 2]), "alarm-pulse");
      // ring：scale 0.15 以 (10,0) 为中心（半宽 6.67），四粒子极径 ≤4.44 全可见（quad ≈1.2px）；
      // alarm 最远 x=0.25 → NDC -1.46、flow 最近 x=19.98 → NDC 1.50、爆发 → -2.25，均在视口外。
      expandingRingRenderedNonBackgroundPixels = await renderPresetNonBackgroundPixels(session, pass,
        binding, orthoEvidenceCamera(0.15, [10, 0]), "expanding-ring");
      // flow：scale 0.25 以 (22,2) 为中心，线段 NDC x/y ∈ [-0.49,0.30] 全可见；ring 最远
      // x=13.27 → NDC -2.18、alarm → -5.44、爆发 → -6.75，均在视口外。
      flowLineRenderedNonBackgroundPixels = await renderPresetNonBackgroundPixels(session, pass,
        binding, orthoEvidenceCamera(0.25, [22, 2]), "flow-line");
    } finally {
      runResourceCleanup("Deep GPU particle render probe cleanup failed.", [() => pass.dispose()]);
    }
    const success = aliveCount === expectedAlive && indirect[0] === 6 && indirect[1] === expectedAlive
      && presetsVerified && timeContinuous && burstVerified && burstBudgetDegraded
      && expiredParticleRemoved && failureRetainedActive
      // 每预设渲染断言：三个专属取景都必须产生非背景像素，缺一即整体 fail。
      && (renderedNonBackgroundPixels ?? 0) > 0
      && (expandingRingRenderedNonBackgroundPixels ?? 0) > 0
      && (flowLineRenderedNonBackgroundPixels ?? 0) > 0;
    return Object.freeze({ action: "gpu-particles", success, aliveCount, indirectCount: indirect[1]!,
      presetsVerified, timeContinuous, burstCount, burstBudgetDegraded,
      expiredParticleRemoved, failureRetainedActive, renderedNonBackgroundPixels,
      expandingRingRenderedNonBackgroundPixels, flowLineRenderedNonBackgroundPixels });
  } finally {
    if (readback?.mapState === "mapped") readback.unmap();
    if (readback) session.release(readback); runtime.dispose();
  }
}

function matchesExpected(particles: readonly ReadParticle[], seed: GpuParticleSeed, deltaTime: number): boolean {
  const particle = particles.find(candidate => candidate.id === seed.id);
  if (!particle) return false;
  const unwrappedAge = (seed.age ?? 0) + deltaTime;
  const cycles = Math.floor(unwrappedAge / seed.lifetime);
  const elapsed = deltaTime - cycles * seed.lifetime;
  const expectedPosition = seed.position.map((value, axis) => value + seed.velocity[axis]! * elapsed);
  return Math.abs(particle.age - (unwrappedAge - cycles * seed.lifetime)) < 1e-4
    && expectedPosition.every((value, axis) => Math.abs(particle.position[axis]! - value) < 1e-4);
}

/**
 * 单预设离屏渲染像素统计：完整复用既有资源模式（rgba8unorm HDR + depth24plus 深度 +
 * MAP_READ 像素缓冲 + 空白对照 clear），按给定取景相机做一次产品 pass.encode →
 * drawIndirect 绘制后读回像素，返回非背景（RGB 任一通道 > 0）的 texel 数。
 * 只做渲染与像素读回，不触碰模拟状态。
 */
async function renderPresetNonBackgroundPixels(session: DeviceSession, pass: PbrParticlePass,
  binding: GpuParticleRenderBinding, camera: ParticlePassCamera, preset: string): Promise<number> {
  const size = 128;
  const hdr = session.own(session.device.createTexture({ label: `Deep GPU particle probe HDR ${preset}`,
    size: { width: size, height: size }, format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
  const depth = session.own(session.device.createTexture({ label: `Deep GPU particle probe depth ${preset}`,
    size: { width: size, height: size }, format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT }));
  const pixels = session.own(session.device.createBuffer({ label: `Deep GPU particle pixel readback ${preset}`,
    size: size * size * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  try {
    // 空白对照：先把 HDR 清成 (0,0,0,1)；pass.encode 用 loadOp "load"，在干净背景上叠加绘制。
    const blankEncoder = session.device.createCommandEncoder({ label: `particle blank ${preset}` });
    const clearPass = blankEncoder.beginRenderPass({ label: `particle blank clear ${preset}`,
      colorAttachments: [{ view: hdr.createView(), loadOp: "clear", storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1,
        depthLoadOp: "clear", depthStoreOp: "store" } });
    clearPass.end();
    session.device.queue.submit([blankEncoder.finish()]);
    const drawEncoder = session.device.createCommandEncoder({ label: `particle draw ${preset}` });
    pass.encode({ encoder: drawEncoder, colorView: hdr.createView(), depthView: depth.createView(),
      width: size, height: size, camera, binding });
    session.device.queue.submit([drawEncoder.finish()]);
    const copyEncoder = session.device.createCommandEncoder({ label: `particle pixel copy ${preset}` });
    copyEncoder.copyTextureToBuffer({ texture: hdr }, { buffer: pixels, bytesPerRow: size * 4,
      rowsPerImage: size }, { width: size, height: size });
    session.device.queue.submit([copyEncoder.finish()]);
    await pixels.mapAsync(GPUMapMode.READ);
    const texels = new Uint8Array(pixels.getMappedRange().slice(0));
    pixels.unmap();
    let nonBackground = 0;
    for (let index = 0; index < texels.length; index += 4) {
      if (texels[index]! > 0 || texels[index + 1]! > 0 || texels[index + 2]! > 0) nonBackground += 1;
    }
    return nonBackground;
  } finally {
    runResourceCleanup(`Deep GPU particle render probe cleanup failed (${preset}).`, [
      () => session.release(hdr), () => session.release(depth), () => session.release(pixels),
    ]);
  }
}

/**
 * 证据专用正交取景相机：NDC = scale·(world − center)，z 行置零使全部片元深度恒 0.5
 * （清屏深度 1、less-equal 通过）；世界坐标越出 center ± 1/scale 的部分被 NDC 裁剪，
 * 以此把非目标预设推出视口。列主序展开，与产品相机合同一致。
 */
function orthoEvidenceCamera(scale: number, center: readonly [number, number]): ParticlePassCamera {
  return { viewProjection: [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 0, 0,
    -scale * center[0], -scale * center[1], 0.5, 1],
    cameraRight: [1, 0, 0], cameraUp: [0, 1, 0] };
}

/** 独立入口：自行打开 DeviceSession，供 headless runner 直接调用。 */
export async function runGpuParticleProbeStandalone(): Promise<GpuParticleProbeResult> {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  const { DeviceSession } = await import("../src/webgpu/deviceSession.js");
  const canvas = new OffscreenCanvas(8, 8) as unknown as HTMLCanvasElement;
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  try { return await runGpuParticleProbe(session); }
  finally { session.dispose(); }
}
