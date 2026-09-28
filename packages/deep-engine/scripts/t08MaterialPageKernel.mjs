/**
 * T08 材质黄金表实机 GPU 采集的页内内核（playwright evaluate 序列化注入，必须自包含）。
 * 生产求值核 = payload.wgsl（EXTENDED_MATERIAL_EVALUATION_WGSL，与 CPU 参考逐公式镜像）；
 * 本文件只注入测试脚手架入口：42 行黄金对拍 + 白炉半球积分（workgroupAdd 归约）。
 * 输入/输出全部走 storage 缓冲（f32），参数块按 materialParameterAbi 的 6-float 顺序。
 */
export async function t08MaterialPageKernel(payload) {
  const decodeBase64 = (text) => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  const encodeBase64 = (buffer) => {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  const queueErrors = [];
  device.addEventListener("uncapturederror", (event) => queueErrors.push(String(event?.error?.message ?? event)));
  const goldensScaffold = `
const GOLDEN_ROW_COUNT: u32 = ${payload.rowCount}u;
@group(0) @binding(0) var<storage, read> goldenInputs: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> goldenOutputs: array<vec4f>;

@compute @workgroup_size(64)
fn evaluateGoldens(@builtin(global_invocation_id) gid: vec3u) {
  let row = gid.x;
  if (row >= GOLDEN_ROW_COUNT) { return; }
  let base = row * 8u;
  let v0 = goldenInputs[base]; let v1 = goldenInputs[base + 1u];
  let v2 = goldenInputs[base + 2u]; let v3 = goldenInputs[base + 3u];
  let v4 = goldenInputs[base + 4u]; let v5 = goldenInputs[base + 5u];
  let v6 = goldenInputs[base + 6u]; let v7 = goldenInputs[base + 7u];
  let params = DeepMaterialEvalParams(v6.x, v6.y, v6.z, v6.w, v7.x, v7.y);
  let result = deepEvaluateExtendedMaterial(v0.xyz, v0.w, v1.w, v1.xyz, v2.xyz, v3.xyz, v4.xyz, v5.xyz, params);
  let outBase = row * 5u;
  goldenOutputs[outBase] = vec4f(result.rgb, 1.0);
  goldenOutputs[outBase + 1u] = vec4f(result.diffuse, 1.0);
  goldenOutputs[outBase + 2u] = vec4f(result.specular, 1.0);
  goldenOutputs[outBase + 3u] = vec4f(result.clearcoatLobe, 1.0);
  goldenOutputs[outBase + 4u] = vec4f(result.transmissionLobe, 1.0);
}`;
  const furnaceScaffold = `
const FURNACE_CONFIG_COUNT: u32 = ${payload.furnaceConfigCount}u;
const FURNACE_THETA: u32 = ${payload.furnaceTheta}u;
const FURNACE_PHI: u32 = ${payload.furnacePhi}u;
@group(0) @binding(0) var<storage, read> furnaceInputs: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> furnaceOutputs: array<f32>;
var<workgroup> furnaceReduce: array<f32, 256>;

@compute @workgroup_size(256)
fn integrateFurnace(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let config = wid.x;
  if (config >= FURNACE_CONFIG_COUNT) { return; }
  let base = config * 4u;
  let v0 = furnaceInputs[base]; let v1 = furnaceInputs[base + 1u];
  let v2 = furnaceInputs[base + 2u]; let v3 = furnaceInputs[base + 3u];
  let params = DeepMaterialEvalParams(v2.x, v2.y, v2.z, v2.w, v3.x, v3.y);
  let directions = FURNACE_THETA * FURNACE_PHI;
  var sum = 0.0;
  for (var k = 0u; k < directions / 256u; k++) {
    let index = lid.x + k * 256u;
    let theta = (f32(index % FURNACE_THETA) + 0.5) * (DEEP_MATERIAL_PI * 0.5) / f32(FURNACE_THETA);
    let phi = (f32(index / FURNACE_THETA) + 0.5) * 2.0 * DEEP_MATERIAL_PI / f32(FURNACE_PHI);
    let sinTheta = sin(theta);
    let light = vec3f(sinTheta * cos(phi), sinTheta * sin(phi), cos(theta));
    let weight = cos(theta) * sinTheta * DEEP_MATERIAL_PI * DEEP_MATERIAL_PI
      / (f32(FURNACE_THETA) * f32(FURNACE_PHI));
    let r = deepEvaluateExtendedMaterial(v0.xyz, v0.w, v1.w, vec3f(0.0, 0.0, 1.0), v1.xyz, light,
      vec3f(1.0, 0.0, 0.0), vec3f(1.0, 1.0, 1.0), params);
    sum += (r.rgb.r + r.rgb.g + r.rgb.b) / 3.0 * weight;
  }
  // Chrome 稳定版未开放 workgroupAdd 内建：共享内存 + 线程 0 顺序归约(确定性,无原子竞争)。
  furnaceReduce[lid.x] = sum;
  workgroupBarrier();
  if (lid.x == 0u) {
    var total = 0.0;
    for (var i = 0u; i < 256u; i++) { total += furnaceReduce[i]; }
    furnaceOutputs[config] = total;
  }
}`;
  // 生产核 + 各自 scaffold 分成两个 module:每个 pipeline 只有 group 0,
  // 避免「pipeline layout 声明了 group 1 就必须每个 pass 都 set」的 Dawn 校验。
  const makeModule = (label, scaffold) => {
    const shader = device.createShaderModule({ label, code: `${payload.wgsl}\n${scaffold}` });
    return shader;
  };
  const goldensShader = makeModule("t08 goldens", goldensScaffold);
  const furnaceShader = makeModule("t08 furnace", furnaceScaffold);
  const messages = [];
  for (const shader of [goldensShader, furnaceShader]) {
    const compilation = await shader.getCompilationInfo();
    for (const item of compilation.messages) {
      messages.push(`${item.type}: ${item.message}`);
    }
  }
  if (messages.length) throw new Error(messages.join("\n"));
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }] });
  const makePipeline = (module, entry) => device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: entry } });
  const goldensPipeline = makePipeline(goldensShader, "evaluateGoldens");
  const furnacePipeline = makePipeline(furnaceShader, "integrateFurnace");
  const goldensInputs = device.createBuffer({ size: payload.rowCount * 128,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const goldensOutputs = device.createBuffer({ size: payload.rowCount * 5 * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const furnaceInputs = device.createBuffer({ size: payload.furnaceConfigCount * 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const furnaceOutputs = device.createBuffer({ size: payload.furnaceConfigCount * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  device.queue.writeBuffer(goldensInputs, 0, decodeBase64(payload.goldensB64));
  device.queue.writeBuffer(furnaceInputs, 0, decodeBase64(payload.furnaceB64));
  const goldenBindings = device.createBindGroup({ layout, entries: [
    { binding: 0, resource: { buffer: goldensInputs } }, { binding: 1, resource: { buffer: goldensOutputs } }] });
  const furnaceBindings = device.createBindGroup({ layout, entries: [
    { binding: 0, resource: { buffer: furnaceInputs } }, { binding: 1, resource: { buffer: furnaceOutputs } }] });
  const encodeGoldens = () => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass({ label: "t08 goldens" });
    pass.setPipeline(goldensPipeline); pass.setBindGroup(0, goldenBindings);
    pass.dispatchWorkgroups(Math.ceil(payload.rowCount / 64)); pass.end();
    return encoder.finish();
  };
  const encodeFurnace = () => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass({ label: "t08 furnace" });
    pass.setPipeline(furnacePipeline); pass.setBindGroup(0, furnaceBindings);
    pass.dispatchWorkgroups(payload.furnaceConfigCount); pass.end();
    return encoder.finish();
  };
  const durations = [];
  for (let sample = 0; sample < payload.warmup + payload.samples; sample++) {
    const started = performance.now();
    device.queue.submit([encodeGoldens()]);
    await device.queue.onSubmittedWorkDone();
    if (sample >= payload.warmup) durations.push(performance.now() - started);
  }
  const furnaceDurations = [];
  for (let sample = 0; sample < 5 + payload.furnaceSamples; sample++) {
    const started = performance.now();
    device.queue.submit([encodeFurnace()]);
    await device.queue.onSubmittedWorkDone();
    if (sample >= 5) furnaceDurations.push(performance.now() - started);
  }
  const readGoldens = device.createBuffer({ size: goldensOutputs.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const readFurnace = device.createBuffer({ size: furnaceOutputs.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(goldensOutputs, 0, readGoldens, 0, goldensOutputs.size);
  encoder.copyBufferToBuffer(furnaceOutputs, 0, readFurnace, 0, furnaceOutputs.size);
  device.queue.submit([encoder.finish()]);
  await readGoldens.mapAsync(GPUMapMode.READ);
  await readFurnace.mapAsync(GPUMapMode.READ);
  const goldensBytes = readGoldens.getMappedRange().slice(0);
  const furnaceBytes = readFurnace.getMappedRange().slice(0);
  readGoldens.unmap(); readFurnace.unmap();
  // 重置语义联测：同一 pipeline/bind group（缓存所在的层）上重写参数块后重新求值；
  // 若任何层缓存了旧结果，generation-bump 后的第二轮输出就会停留在旧值。
  let resetB64 = null;
  if (payload.goldensResetB64) {
    device.queue.writeBuffer(goldensInputs, 0, decodeBase64(payload.goldensResetB64));
    const resetEncoder = device.createCommandEncoder();
    const pass = resetEncoder.beginComputePass({ label: "t08 goldens reset" });
    pass.setPipeline(goldensPipeline); pass.setBindGroup(0, goldenBindings);
    pass.dispatchWorkgroups(Math.ceil(payload.rowCount / 64)); pass.end();
    device.queue.submit([resetEncoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    const readReset = device.createBuffer({ size: goldensOutputs.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const resetCopy = device.createCommandEncoder();
    resetCopy.copyBufferToBuffer(goldensOutputs, 0, readReset, 0, goldensOutputs.size);
    device.queue.submit([resetCopy.finish()]);
    await readReset.mapAsync(GPUMapMode.READ);
    resetB64 = encodeBase64(readReset.getMappedRange().slice(0));
    readReset.unmap();
  }
  const info = adapter.info ?? {};
  return { goldensB64: encodeBase64(goldensBytes), furnaceB64: encodeBase64(furnaceBytes), resetB64,
    durations, furnaceDurations, queueErrors, messages,
    adapter: { vendor: info.vendor ?? "", architecture: info.architecture ?? "",
      device: info.device ?? "", description: info.description ?? "" } };
}
