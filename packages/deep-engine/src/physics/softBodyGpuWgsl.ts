/**
 * T18 A3: deterministic, single-workgroup soft-body compute kernel and CPU mirror.
 *
 * The validation slice keeps one invocation responsible for all particles, edges,
 * and tetrahedra. This is intentionally serial: the reduction/order contract is
 * explicit before a production parallel coloring scheme is introduced.
 */

export const SOFT_BODY_GPU_PARTICLE_STRIDE_BYTES = 48;
export const SOFT_BODY_GPU_EDGE_STRIDE_BYTES = 16;
export const SOFT_BODY_GPU_TET_STRIDE_BYTES = 32;
export const SOFT_BODY_GPU_PARAMS_BYTES = 48;

type SoftBodyVec3 = readonly [number, number, number];

export interface SoftBodyGpuParticleInput {
  readonly position: SoftBodyVec3;
  readonly velocity: SoftBodyVec3;
  readonly inverseMass: number;
}

export interface SoftBodyGpuEdgeInput {
  readonly a: number;
  readonly b: number;
  readonly restLength: number;
}

export interface SoftBodyGpuTetInput {
  readonly i0: number;
  readonly i1: number;
  readonly i2: number;
  readonly i3: number;
  readonly restVolume: number;
}

export interface SoftBodyGpuStepInput {
  readonly particles: readonly SoftBodyGpuParticleInput[];
  readonly edges: readonly SoftBodyGpuEdgeInput[];
  readonly tets: readonly SoftBodyGpuTetInput[];
  readonly dtSeconds: number;
  readonly substeps: number;
  readonly complianceDistance: number;
  readonly complianceVolume: number;
  readonly damping: number;
  readonly gravity: SoftBodyVec3;
}

export function packSoftBodyGpuParticles(particles: readonly SoftBodyGpuParticleInput[]): Float32Array<ArrayBuffer> {
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

export function packSoftBodyGpuEdges(edges: readonly SoftBodyGpuEdgeInput[], particleCount: number): ArrayBuffer {
  const out = new ArrayBuffer(edges.length * SOFT_BODY_GPU_EDGE_STRIDE_BYTES);
  const view = new DataView(out);
  edges.forEach((edge, index) => {
    validateEdge(edge, index, particleCount);
    const offset = index * SOFT_BODY_GPU_EDGE_STRIDE_BYTES;
    view.setUint32(offset, edge.a, true); view.setUint32(offset + 4, edge.b, true);
    view.setFloat32(offset + 8, edge.restLength, true);
  });
  return out;
}

export function packSoftBodyGpuTets(tets: readonly SoftBodyGpuTetInput[], particleCount: number): ArrayBuffer {
  const out = new ArrayBuffer(tets.length * SOFT_BODY_GPU_TET_STRIDE_BYTES);
  const view = new DataView(out);
  tets.forEach((tet, index) => {
    validateTet(tet, index, particleCount);
    const offset = index * SOFT_BODY_GPU_TET_STRIDE_BYTES;
    view.setUint32(offset, tet.i0, true); view.setUint32(offset + 4, tet.i1, true);
    view.setUint32(offset + 8, tet.i2, true); view.setUint32(offset + 12, tet.i3, true);
    view.setFloat32(offset + 16, tet.restVolume, true);
  });
  return out;
}

export function packSoftBodyGpuParams(input: SoftBodyGpuStepInput): ArrayBuffer {
  validateStepInput(input);
  const out = new ArrayBuffer(SOFT_BODY_GPU_PARAMS_BYTES);
  const integers = new Uint32Array(out);
  const floats = new Float32Array(out);
  integers[0] = input.particles.length; integers[1] = input.edges.length;
  integers[2] = input.tets.length; integers[3] = input.substeps;
  floats[4] = Math.fround(input.dtSeconds); floats[5] = Math.fround(input.complianceDistance);
  floats[6] = Math.fround(input.complianceVolume); floats[7] = Math.fround(input.damping);
  floats[8] = Math.fround(input.gravity[0]); floats[9] = Math.fround(input.gravity[1]);
  floats[10] = Math.fround(input.gravity[2]);
  return out;
}

/** CPU mirror of `stepSoftBody`; state uses the WGSL storage-buffer ABI. */
export function mirrorSoftBodyGpuStep(input: SoftBodyGpuStepInput): Float32Array<ArrayBuffer> {
  validateStepInput(input);
  const state = packSoftBodyGpuParticles(input.particles);
  const h = input.dtSeconds / input.substeps;
  const alphaEdge = input.complianceDistance / (h * h);
  const alphaVolume = input.complianceVolume / (h * h);
  const dampingScale = 1 - input.damping * h;
  const [gx, gy, gz] = input.gravity;

  for (let substep = 0; substep < input.substeps; substep += 1) {
    for (let i = 0; i < input.particles.length; i += 1) {
      const base = i * 12;
      state[base + 8] = state[base]!; state[base + 9] = state[base + 1]!; state[base + 10] = state[base + 2]!;
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
    for (const edge of input.edges) projectEdge(state, edge, alphaEdge);
    for (const tet of input.tets) projectVolume(state, tet, alphaVolume);
    const inverseH = 1 / h;
    for (let i = 0; i < input.particles.length; i += 1) {
      const base = i * 12;
      if (state[base + 3] === 0) {
        state[base + 4] = 0; state[base + 5] = 0; state[base + 6] = 0;
      } else {
        state[base + 4] = (state[base]! - state[base + 8]!) * inverseH;
        state[base + 5] = (state[base + 1]! - state[base + 9]!) * inverseH;
        state[base + 6] = (state[base + 2]! - state[base + 10]!) * inverseH;
      }
    }
  }
  assertFinite(state, "soft-body GPU mirror state");
  return state;
}

function projectEdge(state: Float32Array, edge: SoftBodyGpuEdgeInput, alpha: number): void {
  const a = edge.a * 12; const b = edge.b * 12;
  const wa = state[a + 3]!; const wb = state[b + 3]!; const denominator = wa + wb;
  if (denominator === 0) return;
  const dx = state[a]! - state[b]!; const dy = state[a + 1]! - state[b + 1]!; const dz = state[a + 2]! - state[b + 2]!;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length === 0) return;
  const correction = (edge.restLength - length) / (denominator + alpha);
  const nx = dx / length; const ny = dy / length; const nz = dz / length;
  state[a] = state[a]! + wa * correction * nx; state[a + 1] = state[a + 1]! + wa * correction * ny; state[a + 2] = state[a + 2]! + wa * correction * nz;
  state[b] = state[b]! - wb * correction * nx; state[b + 1] = state[b + 1]! - wb * correction * ny; state[b + 2] = state[b + 2]! - wb * correction * nz;
}

function projectVolume(state: Float32Array, tet: SoftBodyGpuTetInput, alpha: number): void {
  const ids = [tet.i0, tet.i1, tet.i2, tet.i3];
  const p = ids.map(index => index * 12);
  const e1 = sub(state, p[1]!, p[3]!); const e2 = sub(state, p[2]!, p[3]!);
  const g0 = scale(cross(e1, e2), 1 / 6);
  const g1 = scale(cross(e2, sub(state, p[0]!, p[3]!)), 1 / 6);
  const g2 = scale(cross(sub(state, p[0]!, p[3]!), e1), 1 / 6);
  const gradients = [g0, g1, g2, [-g0[0] - g1[0] - g2[0], -g0[1] - g1[1] - g2[1], -g0[2] - g1[2] - g2[2]] as const];
  let denominator = 0;
  for (let i = 0; i < 4; i += 1) {
    const w = state[p[i]! + 3]!; const g = gradients[i]!;
    denominator += w * (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
  }
  if (denominator === 0) return;
  const volume = dot(sub(state, p[0]!, p[3]!), cross(sub(state, p[1]!, p[3]!), sub(state, p[2]!, p[3]!))) / 6;
  const correction = (tet.restVolume - volume) / (denominator + alpha);
  for (let i = 0; i < 4; i += 1) {
    const base = p[i]!; const w = state[base + 3]!; const g = gradients[i]!; const scaleValue = w * correction;
    state[base] = state[base]! + scaleValue * g[0]; state[base + 1] = state[base + 1]! + scaleValue * g[1]; state[base + 2] = state[base + 2]! + scaleValue * g[2];
  }
}

function sub(state: Float32Array, a: number, b: number): [number, number, number] {
  return [state[a]! - state[b]!, state[a + 1]! - state[b + 1]!, state[a + 2]! - state[b + 2]!];
}
function cross(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function scale(a: readonly [number, number, number], value: number): [number, number, number] { return [a[0] * value, a[1] * value, a[2] * value]; }
function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function validateStepInput(input: SoftBodyGpuStepInput): void {
  if (!input || input.particles.length < 4) throw new Error("Soft-body GPU step needs at least four particles.");
  if (!Number.isSafeInteger(input.substeps) || input.substeps < 1) throw new Error("Soft-body GPU substeps must be an integer >= 1.");
  if (!(input.dtSeconds > 0) || !Number.isFinite(input.dtSeconds)) throw new Error("Soft-body GPU dtSeconds must be positive and finite.");
  if (!(input.complianceDistance >= 0) || !Number.isFinite(input.complianceDistance)) throw new Error("Soft-body GPU distance compliance must be finite and >= 0.");
  if (!(input.complianceVolume >= 0) || !Number.isFinite(input.complianceVolume)) throw new Error("Soft-body GPU volume compliance must be finite and >= 0.");
  if (!(input.damping >= 0) || input.damping >= 1 || !Number.isFinite(input.damping)) throw new Error("Soft-body GPU damping must be finite in [0,1).");
  if (input.gravity.length !== 3 || !input.gravity.every(Number.isFinite)) throw new Error("Soft-body GPU gravity must contain three finite values.");
  input.particles.forEach((particle, index) => validateParticle(particle, index));
  input.edges.forEach((edge, index) => validateEdge(edge, index, input.particles.length));
  input.tets.forEach((tet, index) => validateTet(tet, index, input.particles.length));
}
function validateParticle(particle: SoftBodyGpuParticleInput, index: number): void {
  if (!particle.position.every(Number.isFinite) || !particle.velocity.every(Number.isFinite)
    || !Number.isFinite(particle.inverseMass) || particle.inverseMass < 0) throw new Error(`Soft-body GPU particle ${index} is invalid.`);
}
function validateEdge(edge: SoftBodyGpuEdgeInput, index: number, count: number): void {
  if (!Number.isSafeInteger(edge.a) || !Number.isSafeInteger(edge.b) || edge.a < 0 || edge.a >= count || edge.b < 0 || edge.b >= count) throw new Error(`Soft-body GPU edge ${index} references a particle outside [0,${count}).`);
  if (!(edge.restLength > 0) || !Number.isFinite(edge.restLength)) throw new Error(`Soft-body GPU edge ${index} restLength must be positive and finite.`);
}
function validateTet(tet: SoftBodyGpuTetInput, index: number, count: number): void {
  for (const id of [tet.i0, tet.i1, tet.i2, tet.i3]) if (!Number.isSafeInteger(id) || id < 0 || id >= count) throw new Error(`Soft-body GPU tet ${index} references a particle outside [0,${count}).`);
  if (!(tet.restVolume > 0) || !Number.isFinite(tet.restVolume)) throw new Error(`Soft-body GPU tet ${index} restVolume must be positive and finite.`);
}
function assertFinite(values: Float32Array, label: string): void {
  for (let i = 0; i < values.length; i += 1) if (!Number.isFinite(values[i])) throw new Error(`${label} became non-finite at ${i}.`);
}

export const SOFT_BODY_GPU_COMPUTE_WGSL = /* wgsl */ `
struct SoftBodyParticle { position: vec4f, velocity: vec4f, previous: vec4f }
struct SoftBodyEdge { a: u32, b: u32, restLength: f32, _padding: u32 }
struct SoftBodyTet { i0: u32, i1: u32, i2: u32, i3: u32, restVolume: f32, _p0: u32, _p1: u32, _p2: u32 }
struct SoftBodyParams {
  particleCount: u32, edgeCount: u32, tetCount: u32, substeps: u32,
  dtSeconds: f32, complianceDistance: f32, complianceVolume: f32, damping: f32,
  gravity: vec4f,
}
@group(0) @binding(0) var<storage, read_write> particles: array<SoftBodyParticle>;
@group(0) @binding(1) var<storage, read> edges: array<SoftBodyEdge>;
@group(0) @binding(2) var<storage, read> tets: array<SoftBodyTet>;
@group(0) @binding(3) var<uniform> params: SoftBodyParams;

fn cross3(a: vec3f, b: vec3f) -> vec3f { return cross(a, b); }
fn volumeGradient0(p0: vec3f, p1: vec3f, p2: vec3f, p3: vec3f) -> vec3f { return cross3(p1 - p3, p2 - p3) / 6.0; }
fn volumeGradient1(p0: vec3f, p1: vec3f, p2: vec3f, p3: vec3f) -> vec3f { return cross3(p2 - p3, p0 - p3) / 6.0; }
fn volumeGradient2(p0: vec3f, p1: vec3f, p2: vec3f, p3: vec3f) -> vec3f { return cross3(p0 - p3, p1 - p3) / 6.0; }
fn volumeGradient(state: u32, corner: u32) -> vec3f {
  let tet = tets[state];
  let p0 = particles[tet.i0].position.xyz; let p1 = particles[tet.i1].position.xyz;
  let p2 = particles[tet.i2].position.xyz; let p3 = particles[tet.i3].position.xyz;
  let g0 = volumeGradient0(p0, p1, p2, p3);
  let g1 = volumeGradient1(p0, p1, p2, p3);
  let g2 = volumeGradient2(p0, p1, p2, p3);
  if (corner == 0u) { return g0; }
  if (corner == 1u) { return g1; }
  if (corner == 2u) { return g2; }
  return -(g0 + g1 + g2);
}

@compute @workgroup_size(1, 1, 1)
fn stepSoftBody(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }
  let h = params.dtSeconds / max(f32(params.substeps), 1.0);
  let alphaEdge = params.complianceDistance / (h * h);
  let alphaVolume = params.complianceVolume / (h * h);
  let dampingScale = 1.0 - params.damping * h;
  for (var substep = 0u; substep < params.substeps; substep += 1u) {
    for (var i = 0u; i < params.particleCount; i += 1u) {
      var particle = particles[i]; particle.previous = particle.position;
      if (particle.position.w == 0.0) { particle.velocity = vec4f(0.0); }
      else {
        let velocity = (particle.velocity.xyz + params.gravity.xyz * h) * dampingScale;
        particle.velocity = vec4f(velocity, particle.velocity.w);
        let position = particle.position.xyz + velocity * h;
        particle.position = vec4f(position, particle.position.w);
      }
      particles[i] = particle;
    }
    for (var e = 0u; e < params.edgeCount; e += 1u) {
      let edge = edges[e]; var a = particles[edge.a]; var b = particles[edge.b];
      let delta = a.position.xyz - b.position.xyz; let length = sqrt(dot(delta, delta));
      let denominator = a.position.w + b.position.w;
      if (length > 0.0 && denominator > 0.0) {
        let correction = (edge.restLength - length) / (denominator + alphaEdge); let direction = delta / length;
        a.position = vec4f(a.position.xyz + direction * correction * a.position.w, a.position.w);
        b.position = vec4f(b.position.xyz - direction * correction * b.position.w, b.position.w);
        particles[edge.a] = a; particles[edge.b] = b;
      }
    }
    for (var t = 0u; t < params.tetCount; t += 1u) {
      let tet = tets[t]; let ids = array<u32, 4>(tet.i0, tet.i1, tet.i2, tet.i3);
      var gradients = array<vec3f, 4>(); var denominator = 0.0;
      for (var corner = 0u; corner < 4u; corner += 1u) {
        gradients[corner] = volumeGradient(t, corner);
        denominator += particles[ids[corner]].position.w * dot(gradients[corner], gradients[corner]);
      }
      if (denominator > 0.0) {
        let p0 = particles[tet.i0].position.xyz; let p1 = particles[tet.i1].position.xyz;
        let p2 = particles[tet.i2].position.xyz; let p3 = particles[tet.i3].position.xyz;
        let volume = dot(p0 - p3, cross3(p1 - p3, p2 - p3)) / 6.0;
        let correction = (tet.restVolume - volume) / (denominator + alphaVolume);
        for (var corner = 0u; corner < 4u; corner += 1u) {
          var particle = particles[ids[corner]];
          let position = particle.position.xyz + gradients[corner] * correction * particle.position.w;
          particle.position = vec4f(position, particle.position.w);
          particles[ids[corner]] = particle;
        }
      }
    }
    for (var i = 0u; i < params.particleCount; i += 1u) {
      var particle = particles[i];
      if (particle.position.w == 0.0) { particle.velocity = vec4f(0.0); }
      else {
        let velocity = (particle.position.xyz - particle.previous.xyz) / h;
        particle.velocity = vec4f(velocity, particle.velocity.w);
      }
      particles[i] = particle;
    }
  }
}
`;
