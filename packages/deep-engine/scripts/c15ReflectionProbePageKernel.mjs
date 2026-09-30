// C15 页内核(在 headless Chrome 页面内执行):真实 WebGPU compute 跑生产 WGSL 单源核。
// 输入用例(position/direction/probe)打包进 storage,输出校正方向+命中距离+影响体权重
// 读回;附带计时基线核(同规模、不调用盒投影)用于逐调用成本增量口径。
export async function c15ReflectionProbePageKernel(input) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { return { error: "no adapter" }; }
  const device = await adapter.requestDevice();
  const queueErrors = [];
  device.addEventListener("uncapturederror", event => queueErrors.push(String(event.error?.message ?? event.error)));
  device.pushErrorScope("validation");

  const driver = /* wgsl */ `
struct CaseInput {
  position: vec3f,
  direction: vec3f,
  box: DeepReflectionProbeBox,
};
struct Params { caseCount: u32, iterations: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<storage, read> cases: array<CaseInput>;
@group(0) @binding(1) var<storage, read> params: Params;
@group(0) @binding(2) var<storage, read_write> projected: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> weights: array<f32>;

// 精度对拍核:每线程 1 次核心调用,结果全量读回。
@compute @workgroup_size(64)
fn csMain(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.caseCount) { return; }
  let item = cases[gid.x];
  projected[gid.x] = deepReflectionProbeBoxProject(item.position, item.direction, item.box);
  weights[gid.x] = deepReflectionProbeInfluenceWeight(item.position, item.box);
}

// 成本核:每线程迭代 params.iterations 次,同数据流(load 不变),主核调盒投影+权重,
// 基线核以等量廉价乘加替代核心——差值即核心逐调用增量。sum 累积防死代码消除。
@group(1) @binding(0) var<storage, read> baselineCases: array<CaseInput>;
@group(1) @binding(1) var<storage, read> baselineParams: Params;
@group(1) @binding(2) var<storage, read_write> baselineProjected: array<vec4f>;
@group(1) @binding(3) var<storage, read_write> baselineWeights: array<f32>;
@compute @workgroup_size(64)
fn csCostMain(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= baselineParams.caseCount) { return; }
  var sum = 0.0;
  for (var iteration = 0u; iteration < baselineParams.iterations; iteration++) {
    let item = baselineCases[(gid.x + iteration) % baselineParams.caseCount];
    let result = deepReflectionProbeBoxProject(item.position, item.direction, item.box);
    sum += result.x + result.w * deepReflectionProbeInfluenceWeight(item.position, item.box);
  }
  baselineProjected[gid.x] = vec4f(sum, 0.0, 0.0, 0.0);
  baselineWeights[gid.x] = sum;
}
@compute @workgroup_size(64)
fn csCostBaseline(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= baselineParams.caseCount) { return; }
  var sum = 0.0;
  for (var iteration = 0u; iteration < baselineParams.iterations; iteration++) {
    let item = baselineCases[(gid.x + iteration) % baselineParams.caseCount];
    let cheap = item.direction * 2.0;
    sum += cheap.x + cheap.y;
  }
  baselineProjected[gid.x] = vec4f(sum, 0.0, 0.0, 0.0);
  baselineWeights[gid.x] = sum;
}
`;
  const module = device.createShaderModule({ code: input.wgslLibrary + driver });
  const compilationInfo = await module.getCompilationInfo();
  const messages = compilationInfo.messages.map(m => `${m.type}: ${m.lineNum}:${m.linePos} ${m.message}`);
  const errors = messages.filter(m => m.startsWith("error"));
  if (errors.length > 0) { return { error: "wgsl compile failed", messages }; }

  const caseCount = input.caseCount;
  const caseStrideFloats = 16; // position+pad / direction+pad / box(center+blend, extents+radius) = 64B
  const caseBytes = new Float32Array(caseCount * caseStrideFloats);
  caseBytes.set(input.cases);
  // 精度对拍核按 caseCount 出网格;成本核按 costThreads 出网格、每线程 iterations 次迭代。
  const costThreads = input.costThreads;
  const iterations = input.iterations;
  const params = new Uint32Array([caseCount, 0, 0, 0]);
  const costParams = new Uint32Array([costThreads, iterations, 0, 0]);
  const createInit = (bytes, size) => {
    const buffer = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, bytes);
    return buffer;
  };
  const caseBuffer = createInit(caseBytes, caseBytes.byteLength);
  const paramsBuffer = createInit(params, 16);
  const costParamsBuffer = createInit(costParams, 16);
  const readUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
  const projectedBuffer = device.createBuffer({ size: caseCount * 16, usage: readUsage });
  const weightsBuffer = device.createBuffer({ size: caseCount * 4, usage: readUsage });
  const projectedBase = device.createBuffer({ size: costThreads * 16, usage: readUsage });
  const weightsBase = device.createBuffer({ size: costThreads * 4, usage: readUsage });
  const parityPipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "csMain" },
  });
  const costMainPipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "csCostMain" },
  });
  const costBaselinePipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "csCostBaseline" },
  });
  const groupParity = device.createBindGroup({ layout: parityPipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: caseBuffer } },
    { binding: 1, resource: { buffer: paramsBuffer } },
    { binding: 2, resource: { buffer: projectedBuffer } },
    { binding: 3, resource: { buffer: weightsBuffer } },
  ] });
  const groupCostMain = device.createBindGroup({ layout: costMainPipeline.getBindGroupLayout(1), entries: [
    { binding: 0, resource: { buffer: caseBuffer } },
    { binding: 1, resource: { buffer: costParamsBuffer } },
    { binding: 2, resource: { buffer: projectedBase } },
    { binding: 3, resource: { buffer: weightsBase } },
  ] });
  const groupCostBaseline = device.createBindGroup({ layout: costBaselinePipeline.getBindGroupLayout(1), entries: [
    { binding: 0, resource: { buffer: caseBuffer } },
    { binding: 1, resource: { buffer: costParamsBuffer } },
    { binding: 2, resource: { buffer: projectedBase } },
    { binding: 3, resource: { buffer: weightsBase } },
  ] });

  const parityWorkgroups = Math.ceil(caseCount / 64);
  const costWorkgroups = Math.ceil(costThreads / 64);
  const runParity = () => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(parityPipeline);
    pass.setBindGroup(0, groupParity);
    pass.dispatchWorkgroups(parityWorkgroups);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };
  const runCost = (pipeline, group) => {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(1, group);
    pass.dispatchWorkgroups(costWorkgroups);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };

  const decode = async (buffer, byteLength) => {
    const staging = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, byteLength);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = new Uint8Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return copy.buffer;
  };

  // 预热 + 精度对拍读回(验证读回链路,同时拿结果)。
  for (let warmup = 0; warmup < input.warmup; warmup++) {
    runParity();
    runCost(costMainPipeline, groupCostMain);
    runCost(costBaselinePipeline, groupCostBaseline);
  }
  await device.queue.onSubmittedWorkDone();
  const projectedRaw = await decode(projectedBuffer, caseCount * 16);
  const weightsRaw = await decode(weightsBuffer, caseCount * 4);

  // 成本计时:主核与基线核交替采样(同线程数/迭代数,只差核心数学),均值差 → 逐调用增量。
  const durations = [];
  const baselineDurations = [];
  for (let sample = 0; sample < input.samples; sample++) {
    const start = performance.now();
    runCost(costMainPipeline, groupCostMain);
    await device.queue.onSubmittedWorkDone();
    durations.push(performance.now() - start);
    const baselineStart = performance.now();
    runCost(costBaselinePipeline, groupCostBaseline);
    await device.queue.onSubmittedWorkDone();
    baselineDurations.push(performance.now() - baselineStart);
  }

  const error = await device.popErrorScope();
  if (error) queueErrors.push(`validation: ${error.message}`);
  const result = {
    projectedB64: btoa(String.fromCharCode(...new Uint8Array(projectedRaw))),
    weightsB64: btoa(String.fromCharCode(...new Uint8Array(weightsRaw))),
    messages,
    queueErrors,
    adapter: adapter.info ? `${adapter.info.vendor ?? ""} ${adapter.info.architecture ?? ""}`.trim() : "",
    timings: { durations, baselineDurations },
    caseCount,
    costThreads,
    iterations,
  };
  device.destroy();
  return result;
}
