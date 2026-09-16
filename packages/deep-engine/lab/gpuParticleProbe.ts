import {
  GPU_PARTICLE_INDIRECT_BYTES, GPU_PARTICLE_STRIDE, GpuParticleRuntime,
  compileGpuParticleEmitters, submitGpuParticleEmitterFrame,
  type DeviceSession, type GpuParticleSeed,
} from "@bim-studio/deep-engine/webgpu";

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
    const binding = moved.snapshot?.binding;
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
    const success = aliveCount === expectedAlive && indirect[0] === 6 && indirect[1] === expectedAlive
      && presetsVerified && timeContinuous && burstVerified && burstBudgetDegraded
      && expiredParticleRemoved && failureRetainedActive;
    return Object.freeze({ action: "gpu-particles", success, aliveCount, indirectCount: indirect[1]!,
      presetsVerified, timeContinuous, burstCount, burstBudgetDegraded,
      expiredParticleRemoved, failureRetainedActive });
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
