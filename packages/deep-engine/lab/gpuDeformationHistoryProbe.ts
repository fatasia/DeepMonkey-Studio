import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { GpuDeformationHistory, type GpuDeformationHistorySource, type GpuDeformationHistoryResult } from "../src/webgpu/gpuDeformationHistory.js";

/** Isolates history using fixed GPU-buffer inputs; does not claim skin/morph producer integration. */
export async function runGpuDeformationHistoryProbe() {
  const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32; document.body.append(canvas);
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const device = session.device, history = new GpuDeformationHistory(session), owned: GPUBuffer[] = [];
  const buffer = (size: number, usage: GPUBufferUsageFlags) => {
    const value = device.createBuffer({ size, usage }); owned.push(value); return value;
  };
  const vertexCount = 2, outputBytes = vertexCount * 48;
  const source32 = buffer(vertexCount * 32, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const source48 = buffer(outputBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
  const readback = buffer(outputBytes * 2, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const pose32 = (offset: number) => new Float32Array([offset, 2, 3, 1, 0, 1, 0, 0, offset + 1, 5, 6, 1, 1, 0, 0, 0]);
  const expand = (source: Float32Array) => [...source.slice(0, 8), 0, 0, 0, 0, ...source.slice(8, 16), 0, 0, 0, 0];
  const observations: { name: string; passed: boolean; updated: boolean; historyValid: boolean; maxError: number; hasTangents: boolean }[] = [];
  const inspect = async (encoder: GPUCommandEncoder, result: GpuDeformationHistoryResult,
    expectedCurrent: readonly number[], expectedPrevious: readonly number[], name: string, commit: () => void) => {
    encoder.copyBufferToBuffer(result.current, 0, readback, 0, outputBytes);
    encoder.copyBufferToBuffer(result.previous, 0, readback, outputBytes, outputBytes);
    device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone(); commit();
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Float32Array(readback.getMappedRange()), expected = [...expectedCurrent, ...expectedPrevious];
    let maxError = 0;
    for (let index = 0; index < expected.length; index++) maxError = Math.max(maxError, Math.abs(pixels[index]! - expected[index]!));
    readback.unmap();
    observations.push({ name, passed: maxError === 0, updated: result.updated, historyValid: result.historyValid, maxError, hasTangents: result.hasTangents });
  };
  const run = async (source: GpuDeformationHistorySource, expectedCurrent: readonly number[], expectedPrevious: readonly number[], name: string) => {
    const stage = history.begin(source), encoder = device.createCommandEncoder();
    const result = history.encode(encoder, stage);
    await inspect(encoder, result, expectedCurrent, expectedPrevious, name, () => history.commit(stage));
    return result;
  };
  device.pushErrorScope("validation");
  try {
    const first = pose32(1), second = pose32(11), third = pose32(21);
    const source: GpuDeformationHistorySource = { output: source32, vertexCount, outputStride: 32, sourceRevision: 1, poseRevision: 1 };
    device.queue.writeBuffer(source32, 0, first);
    const initial = await run(source, expand(first), expand(first), "32-to-48-first");
    observations[0]!.passed &&= !initial.historyValid && !initial.hasTangents && initial.current === initial.previous;
    device.queue.writeBuffer(source32, 0, second);
    const next = await run({ ...source, poseRevision: 2 }, expand(second), expand(first), "second-submit-previous-preserved");
    observations[1]!.passed &&= next.historyValid && next.current !== next.previous;

    device.queue.writeBuffer(source32, 0, third);
    const cancelled = history.begin({ ...source, poseRevision: 3 }), discardedEncoder = device.createCommandEncoder();
    history.encode(discardedEncoder, cancelled); history.cancel(cancelled);
    await run({ ...source, poseRevision: 3 }, expand(third), expand(second), "cancel-unsubmitted-then-retry");
    const unchanged = await run({ ...source, poseRevision: 3 }, expand(third), expand(third), "same-pose-reuse");
    observations[3]!.passed &&= !unchanged.updated && unchanged.current === unchanged.previous;

    const explicit48 = new Float32Array([31, 2, 3, 1, 0, 1, 0, 0, 1, 0, 0, -1, 41, 5, 6, 1, 1, 0, 0, 0, 0, 1, 0, 1]);
    device.queue.writeBuffer(source48, 0, explicit48);
    const reset = await run({ output: source48, vertexCount, outputStride: 48, sourceRevision: 2, poseRevision: 0, hasTangents: true },
      [...explicit48], [...explicit48], "48-copy-source-reset");
    observations[4]!.passed &&= !reset.historyValid && reset.hasTangents && reset.current === reset.previous;
    history.dispose();
    const validation = await device.popErrorScope();
    return { success: observations.every(item => item.passed) && !validation && !session.hasErrors && session.resourceCount === 0,
      adapter: session.adapterInfo, tolerance: 0, source: "fixed GPU buffers; producer deformation excluded", observations,
      validationError: validation?.message ?? null, diagnostics: session.diagnostics, resourcesAfterDispose: session.resourceCount };
  } catch (error) {
    await device.popErrorScope().catch(() => null); throw error;
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    history.dispose(); for (const item of owned) item.destroy(); session.dispose(); canvas.remove();
  }
}
