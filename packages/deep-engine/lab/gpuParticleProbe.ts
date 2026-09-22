import {
  GPU_PARTICLE_INDIRECT_BYTES, GPU_PARTICLE_STRIDE, GpuParticleRuntime,
  compileGpuParticleEmitters, submitGpuParticleEmitterFrame,
  type DeviceSession, type GpuParticleSeed,
} from "@bim-studio/deep-engine/webgpu";
import { PbrParticlePass } from "../src/webgpu/pbrParticlePass.js";
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
  /** A4 真机渲染证据：离屏 HDR 绘制后非背景像素数量；undefined 表示未执行。 */
  readonly renderedNonBackgroundPixels?: number;
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
  let binding: import("@bim-studio/deep-engine/webgpu").GpuParticleRenderBinding | undefined;
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

    // A4 真机渲染证据：用刚提交的 binding（上一帧模拟结果）在离屏 HDR 上绘制，
    // 读回 rgba8unorm 像素统计非背景数量；空白对照先证明 clear 干净。
    // 渲染块必须在 binding 作用域内：binding 声明在外层 try 中，这里直接引用。
    let renderedNonBackgroundPixels: number | undefined;
    const pass = new PbrParticlePass(session, "rgba8unorm", "depth24plus");
    const size = 128;
    const hdr = session.own(session.device.createTexture({ label: "Deep GPU particle probe HDR",
      size: { width: size, height: size }, format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
    const depth = session.own(session.device.createTexture({ label: "Deep GPU particle probe depth",
      size: { width: size, height: size }, format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT }));
    const pixels = session.own(session.device.createBuffer({ label: "Deep GPU particle pixel readback",
      size: size * size * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    try {
      const blankEncoder = session.device.createCommandEncoder({ label: "particle blank" });
      const clearPass = blankEncoder.beginRenderPass({ label: "particle blank clear", colorAttachments: [{
        view: hdr.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
      clearPass.end();
      session.device.queue.submit([blankEncoder.finish()]);
      const drawEncoder = session.device.createCommandEncoder({ label: "particle draw" });
      pass.encode({ encoder: drawEncoder, colorView: hdr.createView(), depthView: depth.createView(),
        width: size, height: size,
        // 正交近似：把场景坐标缩放 0.1 并把 alarm 中心 (0,2,0) 映射到 NDC (0,0,0.5)。
        camera: { viewProjection: [0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, 0, -0.15, 0.5, 1],
          cameraRight: [1, 0, 0], cameraUp: [0, 1, 0] }, binding });
      session.device.queue.submit([drawEncoder.finish()]);
      const drawPassEncoder = session.device.createCommandEncoder({ label: "particle pixel copy" });
      drawPassEncoder.copyTextureToBuffer({ texture: hdr }, { buffer: pixels, bytesPerRow: size * 4,
        rowsPerImage: size }, { width: size, height: size });
      session.device.queue.submit([drawPassEncoder.finish()]);
      await pixels.mapAsync(GPUMapMode.READ);
      const texels = new Uint8Array(pixels.getMappedRange().slice(0));
      pixels.unmap();
      renderedNonBackgroundPixels = 0;
      for (let index = 0; index < texels.length; index += 4) {
        if (texels[index]! > 0 || texels[index + 1]! > 0 || texels[index + 2]! > 0) renderedNonBackgroundPixels += 1;
      }
    } finally {
      runResourceCleanup("Deep GPU particle render probe cleanup failed.", [
        () => session.release(hdr), () => session.release(depth), () => session.release(pixels),
        () => pass.dispose(),
      ]);
    }
    const success = aliveCount === expectedAlive && indirect[0] === 6 && indirect[1] === expectedAlive
      && presetsVerified && timeContinuous && burstVerified && burstBudgetDegraded
      && expiredParticleRemoved && failureRetainedActive
      && (renderedNonBackgroundPixels ?? 0) > 0;
    return Object.freeze({ action: "gpu-particles", success, aliveCount, indirectCount: indirect[1]!,
      presetsVerified, timeContinuous, burstCount, burstBudgetDegraded,
      expiredParticleRemoved, failureRetainedActive, renderedNonBackgroundPixels });
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
