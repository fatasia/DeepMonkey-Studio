import { GPU_PARTICLE_WORKGROUP_SIZE } from "./gpuParticleTypes.js";

export const GPU_PARTICLE_COMPUTE_WGSL = /* wgsl */ `
struct Particle {
  positionAge: vec4f,
  velocityLifetime: vec4f,
  color: vec4f,
  sizeRotationId: vec4f,
}
struct Counter { value: atomic<u32> }
struct FrameParams {
  deltaTime: f32,
  drag: f32,
  capacity: u32,
  _padding: u32,
  acceleration: vec4f,
}
@group(0) @binding(0) var<storage, read> inputParticles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> inputCounter: Counter;
@group(0) @binding(2) var<storage, read_write> outputParticles: array<Particle>;
@group(0) @binding(3) var<storage, read_write> outputCounter: Counter;
@group(0) @binding(4) var<storage, read_write> indirect: array<u32>;
@group(0) @binding(5) var<uniform> frame: FrameParams;

@compute @workgroup_size(1)
fn resetOutput(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }
  atomicStore(&outputCounter.value, 0u);
  indirect[0] = 6u; indirect[1] = 0u; indirect[2] = 0u; indirect[3] = 0u;
}

@compute @workgroup_size(${GPU_PARTICLE_WORKGROUP_SIZE})
fn simulateAndCompact(@builtin(global_invocation_id) id: vec3u) {
  let inputCount = min(atomicLoad(&inputCounter.value), frame.capacity);
  if (id.x >= inputCount) { return; }
  var particle = inputParticles[id.x];
  var age = particle.positionAge.w + frame.deltaTime;
  let lifetime = particle.velocityLifetime.w;
  let flags = u32(round(particle.sizeRotationId.w));
  let looping = (flags & 1u) != 0u;
  if (age >= lifetime && !looping) { return; }
  let damping = exp(-frame.drag * frame.deltaTime);
  let velocity = (particle.velocityLifetime.xyz + frame.acceleration.xyz * frame.deltaTime) * damping;
  var position = particle.positionAge.xyz + velocity * frame.deltaTime;
  if (looping && age >= lifetime) {
    let cycles = floor(age / lifetime);
    age -= cycles * lifetime; position -= velocity * lifetime * cycles;
  }
  particle.positionAge = vec4f(position, age);
  particle.velocityLifetime = vec4f(velocity, particle.velocityLifetime.w);
  let finitePosition = all(position == position) && all(abs(position) <= vec3f(3.402823e38));
  let finiteVelocity = all(velocity == velocity) && all(abs(velocity) <= vec3f(3.402823e38));
  if (!finitePosition || !finiteVelocity) { return; }
  let destination = atomicAdd(&outputCounter.value, 1u);
  if (destination < frame.capacity) { outputParticles[destination] = particle; }
}

@compute @workgroup_size(1)
fn writeIndirect(@builtin(global_invocation_id) id: vec3u) {
  if (id.x == 0u) { indirect[1] = min(atomicLoad(&outputCounter.value), frame.capacity); }
}
`;

/** Group 0 is owned by GpuParticleRuntime; a renderer supplies the camera at group 1. */
export const GPU_PARTICLE_RENDER_WGSL = /* wgsl */ `
struct Particle {
  positionAge: vec4f,
  velocityLifetime: vec4f,
  color: vec4f,
  sizeRotationId: vec4f,
}
struct ParticleCamera {
  viewProjection: mat4x4f,
  cameraRight: vec4f,
  cameraUp: vec4f,
}
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
}
@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(1) @binding(0) var<uniform> camera: ParticleCamera;

const QUAD = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
  vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));

@vertex fn particleVertex(@builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
  let particle = particles[instanceIndex];
  let corner = QUAD[vertexIndex];
  let flags = u32(round(particle.sizeRotationId.w));
  let phase = particle.positionAge.w / max(particle.velocityLifetime.w, 0.000001);
  let pulse = select(1.0, 0.8 + 0.2 * sin(phase * 6.2831853), (flags & 2u) != 0u);
  let angle = particle.sizeRotationId.y;
  let rotated = vec2f(corner.x * cos(angle) - corner.y * sin(angle),
    corner.x * sin(angle) + corner.y * cos(angle));
  let offset = (camera.cameraRight.xyz * rotated.x + camera.cameraUp.xyz * rotated.y)
    * particle.sizeRotationId.x * pulse;
  var output: VertexOutput;
  output.position = camera.viewProjection * vec4f(particle.positionAge.xyz + offset, 1.0);
  output.uv = corner * 0.5 + 0.5;
  output.color = vec4f(particle.color.rgb, particle.color.a * pulse); return output;
}

@fragment fn particleFragment(input: VertexOutput) -> @location(0) vec4f {
  let radial = length(input.uv * 2.0 - 1.0);
  let alpha = input.color.a * (1.0 - smoothstep(0.7, 1.0, radial));
  return vec4f(input.color.rgb * alpha, alpha);
}
`;
