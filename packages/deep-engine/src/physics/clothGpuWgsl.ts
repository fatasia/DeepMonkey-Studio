/**
 * T18 A3: deterministic, single-workgroup cloth compute kernel and CPU mirror.
 *
 * This is a validation slice, not the production cloth path. One invocation owns
 * the whole state and applies particles/constraints in construction order. That
 * is deliberately serial so the reduction/update order is explicit and stable;
 * a parallel production solver must introduce a separate deterministic coloring
 * or reduction contract before it can replace this slice.
 */

export const CLOTH_GPU_PARTICLE_STRIDE_BYTES = 48;
export const CLOTH_GPU_CONSTRAINT_STRIDE_BYTES = 16;
export const CLOTH_GPU_PARAMS_BYTES = 48;

type ClothVec3 = readonly [number, number, number];

export interface ClothGpuParticleInput {
  readonly position: ClothVec3;
  readonly velocity: ClothVec3;
  readonly inverseMass: number;
}

export interface ClothGpuConstraintInput {
  readonly a: number;
  readonly b: number;
  readonly restLength: number;
}

/** 确定性风(f6):windAcceleration = direction × baseSpeed × (0.5+valueNoise(t·f, y·scale));
 * tickSeconds 由调用方按 tick 基+子步偏移传入(per-substep params 副本)。 */
export interface ClothGpuWind {
  readonly direction: ClothVec3;
  readonly baseSpeed: number;
  readonly gustFrequency: number;
  readonly spatialScale: number;
  readonly seed: number;
  readonly tickSeconds: number;
}

export interface ClothGpuStepInput {
  readonly particles: readonly ClothGpuParticleInput[];
  readonly constraints: readonly ClothGpuConstraintInput[];
  readonly dtSeconds: number;
  readonly substeps: number;
  readonly compliance: number;
  readonly damping: number;
  readonly gravity: ClothVec3;
  readonly wind?: ClothGpuWind;
  /** F6/T18 静态障碍(GPU 接触投影);与 contacts(CPU f64 黄金)同语义的 sphere/cuboid 子集。 */
  readonly obstacles?: ReadonlyArray<ClothGpuObstacleData>;
}

export interface ClothGpuObstacleData {
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly rotation: readonly [number, number, number, number, number, number, number, number, number];
  readonly halfExtents: readonly [number, number, number];
}

/** Packed storage ABI: position/inverse mass, velocity, previous position. */
export function packClothGpuParticles(particles: readonly ClothGpuParticleInput[]): Float32Array<ArrayBuffer> {
  const out = new Float32Array(particles.length * 12);
  particles.forEach((particle, index) => {
    validateParticle(particle, index);
    const base = index * 12;
    out.set([...particle.position, particle.inverseMass], base);
    out.set([...particle.velocity, 0], base + 4);
    out.set([...particle.position, 0], base + 8);
  });
  return out;
}

/** Packed storage ABI for the WGSL `ClothConstraint` structure. */
export function packClothGpuConstraints(constraints: readonly ClothGpuConstraintInput[], particleCount: number): ArrayBuffer {
  const out = new ArrayBuffer(constraints.length * CLOTH_GPU_CONSTRAINT_STRIDE_BYTES);
  const view = new DataView(out);
  constraints.forEach((constraint, index) => {
    validateConstraint(constraint, index, particleCount);
    const offset = index * CLOTH_GPU_CONSTRAINT_STRIDE_BYTES;
    view.setUint32(offset, constraint.a, true);
    view.setUint32(offset + 4, constraint.b, true);
    view.setFloat32(offset + 8, constraint.restLength, true);
  });
  return out;
}

/** Packed uniform ABI for one deterministic fixed-step dispatch. */
export function packClothGpuParams(input: ClothGpuStepInput): ArrayBuffer {
  validateStepInput(input);
  const out = new ArrayBuffer(CLOTH_GPU_PARAMS_BYTES);
  const integers = new Uint32Array(out);
  const floats = new Float32Array(out);
  integers[0] = input.particles.length;
  integers[1] = input.constraints.length;
  integers[2] = input.substeps;
  floats[4] = Math.fround(input.dtSeconds);
  floats[5] = Math.fround(input.compliance);
  floats[6] = Math.fround(input.damping);
  floats[8] = Math.fround(input.gravity[0]);
  floats[9] = Math.fround(input.gravity[1]);
  floats[10] = Math.fround(input.gravity[2]);
  return out;
}

/**
 * CPU mirror of `stepCloth`. The state layout is the same 12-float particle
 * layout used by the storage buffer, making this suitable for contract tests.
 */
export function mirrorClothGpuStep(input: ClothGpuStepInput): Float32Array<ArrayBuffer> {
  validateStepInput(input);
  const state = packClothGpuParticles(input.particles);
  const h = input.dtSeconds / input.substeps;
  const alpha = input.compliance / (h * h);
  const dampingScale = 1 - input.damping * h;
  const [gx, gy, gz] = input.gravity;
  const particleCount = input.particles.length;

  for (let substep = 0; substep < input.substeps; substep += 1) {
    for (let i = 0; i < particleCount; i += 1) {
      const base = i * 12;
      state[base + 8] = state[base]!;
      state[base + 9] = state[base + 1]!;
      state[base + 10] = state[base + 2]!;
      const inverseMass = state[base + 3]!;
      if (inverseMass === 0) {
        state[base + 4] = 0; state[base + 5] = 0; state[base + 6] = 0;
        continue;
      }
      state[base + 4] = (state[base + 4]! + gx * h) * dampingScale;
      state[base + 5] = (state[base + 5]! + gy * h) * dampingScale;
      state[base + 6] = (state[base + 6]! + gz * h) * dampingScale;
      state[base] = state[base]! + state[base + 4]! * h;
      state[base + 1] = state[base + 1]! + state[base + 5]! * h;
      state[base + 2] = state[base + 2]! + state[base + 6]! * h;
    }

    for (const constraint of input.constraints) {
      const aBase = constraint.a * 12;
      const bBase = constraint.b * 12;
      const dx = state[aBase]! - state[bBase]!;
      const dy = state[aBase + 1]! - state[bBase + 1]!;
      const dz = state[aBase + 2]! - state[bBase + 2]!;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (length === 0) continue;
      const wa = state[aBase + 3]!;
      const wb = state[bBase + 3]!;
      const denominator = wa + wb;
      if (denominator === 0) continue;
      const delta = (constraint.restLength - length) / (denominator + alpha);
      const nx = dx / length;
      const ny = dy / length;
      const nz = dz / length;
      state[aBase] = state[aBase]! + wa * delta * nx;
      state[aBase + 1] = state[aBase + 1]! + wa * delta * ny;
      state[aBase + 2] = state[aBase + 2]! + wa * delta * nz;
      state[bBase] = state[bBase]! - wb * delta * nx;
      state[bBase + 1] = state[bBase + 1]! - wb * delta * ny;
      state[bBase + 2] = state[bBase + 2]! - wb * delta * nz;
    }

    const inverseH = 1 / h;
    for (let i = 0; i < particleCount; i += 1) {
      const base = i * 12;
      if (state[base + 3] === 0) {
        state[base + 4] = 0; state[base + 5] = 0; state[base + 6] = 0;
        continue;
      }
      state[base + 4] = (state[base]! - state[base + 8]!) * inverseH;
      state[base + 5] = (state[base + 1]! - state[base + 9]!) * inverseH;
      state[base + 6] = (state[base + 2]! - state[base + 10]!) * inverseH;
    }
  }
  assertFinite(state, "cloth GPU mirror state");
  return state;
}

function validateStepInput(input: ClothGpuStepInput): void {
  if (!input || input.particles.length < 1) throw new Error("Cloth GPU step needs at least one particle.");
  if (!Number.isSafeInteger(input.substeps) || input.substeps < 1) throw new Error("Cloth GPU substeps must be an integer >= 1.");
  if (!(input.dtSeconds > 0) || !Number.isFinite(input.dtSeconds)) throw new Error("Cloth GPU dtSeconds must be positive and finite.");
  if (!(input.compliance >= 0) || !Number.isFinite(input.compliance)) throw new Error("Cloth GPU compliance must be finite and >= 0.");
  if (!(input.damping >= 0) || input.damping >= 1 || !Number.isFinite(input.damping)) throw new Error("Cloth GPU damping must be finite in [0,1).");
  if (input.gravity.length !== 3 || !input.gravity.every(Number.isFinite)) throw new Error("Cloth GPU gravity must contain three finite values.");
  input.particles.forEach((particle, index) => validateParticle(particle, index));
  input.constraints.forEach((constraint, index) => validateConstraint(constraint, index, input.particles.length));
}

function validateParticle(particle: ClothGpuParticleInput, index: number): void {
  if (!particle.position.every(Number.isFinite) || !particle.velocity.every(Number.isFinite)
    || !Number.isFinite(particle.inverseMass) || particle.inverseMass < 0) {
    throw new Error(`Cloth GPU particle ${index} must contain finite position/velocity and non-negative inverse mass.`);
  }
}

function validateConstraint(constraint: ClothGpuConstraintInput, index: number, particleCount: number): void {
  if (!Number.isSafeInteger(constraint.a) || !Number.isSafeInteger(constraint.b)
    || constraint.a < 0 || constraint.a >= particleCount || constraint.b < 0 || constraint.b >= particleCount) {
    throw new Error(`Cloth GPU constraint ${index} references a particle outside [0,${particleCount}).`);
  }
  if (!(constraint.restLength > 0) || !Number.isFinite(constraint.restLength)) throw new Error(`Cloth GPU constraint ${index} restLength must be positive and finite.`);
}

function assertFinite(values: Float32Array, label: string): void {
  for (let i = 0; i < values.length; i += 1) if (!Number.isFinite(values[i])) throw new Error(`${label} became non-finite at ${i}.`);
}

export const CLOTH_GPU_COMPUTE_WGSL = /* wgsl */ `
struct ClothParticle {
  position: vec4f,
  velocity: vec4f,
  previous: vec4f,
}
struct ClothConstraint {
  a: u32,
  b: u32,
  restLength: f32,
  _padding: u32,
}
struct ClothParams {
  particleCount: u32,
  constraintCount: u32,
  substeps: u32,
  _padding0: u32,
  dtSeconds: f32,
  compliance: f32,
  damping: f32,
  _padding1: f32,
  gravity: vec4f,
}
@group(0) @binding(0) var<storage, read_write> particles: array<ClothParticle>;
@group(0) @binding(1) var<storage, read> constraints: array<ClothConstraint>;
@group(0) @binding(2) var<uniform> params: ClothParams;

@compute @workgroup_size(1, 1, 1)
fn stepCloth(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }
  let h = params.dtSeconds / max(f32(params.substeps), 1.0);
  let alpha = params.compliance / (h * h);
  let dampingScale = 1.0 - params.damping * h;
  for (var substep = 0u; substep < params.substeps; substep += 1u) {
    for (var i = 0u; i < params.particleCount; i += 1u) {
      var particle = particles[i];
      particle.previous = particle.position;
      if (particle.position.w == 0.0) {
        particle.velocity = vec4f(0.0);
      } else {
        let velocity = (particle.velocity.xyz + params.gravity.xyz * h) * dampingScale;
        particle.velocity = vec4f(velocity, particle.velocity.w);
        let position = particle.position.xyz + velocity * h;
        particle.position = vec4f(position, particle.position.w);
      }
      particles[i] = particle;
    }
    for (var k = 0u; k < params.constraintCount; k += 1u) {
      let constraint = constraints[k];
      var a = particles[constraint.a];
      var b = particles[constraint.b];
      let delta = a.position.xyz - b.position.xyz;
      let length = sqrt(dot(delta, delta));
      let denominator = a.position.w + b.position.w;
      if (length > 0.0 && denominator > 0.0) {
        let correction = (constraint.restLength - length) / (denominator + alpha);
        let direction = delta / length;
        a.position = vec4f(a.position.xyz + direction * correction * a.position.w, a.position.w);
        b.position = vec4f(b.position.xyz - direction * correction * b.position.w, b.position.w);
        particles[constraint.a] = a;
        particles[constraint.b] = b;
      }
    }
    for (var i = 0u; i < params.particleCount; i += 1u) {
      var particle = particles[i];
      if (particle.position.w == 0.0) {
        particle.velocity = vec4f(0.0);
      } else {
        let velocity = (particle.position.xyz - particle.previous.xyz) / h;
        particle.velocity = vec4f(velocity, particle.velocity.w);
      }
      particles[i] = particle;
    }
  }
}
`;
