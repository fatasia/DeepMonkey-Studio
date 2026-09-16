import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { GpuSkinner, cpuSkinVertices, prepareSkinningInput } from "../src/webgpu/gpuSkinning.js";
import { GpuDeformationHistory } from "../src/webgpu/gpuDeformationHistory.js";
import type { SkinningPalette } from "../src/webgpu/gpuSkinningTypes.js";

/** 真实skin计算→48-byte历史→回读；CPU只作为实验室数值oracle。 */
export async function runGpuSkinTangentProbe(session: DeviceSession) {
  const device = session.device, skin = new GpuSkinner(session), history = new GpuDeformationHistory(session);
  const readback = session.own(device.createBuffer({ label: "Skin tangent history readback", size: 96,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const unit = Math.SQRT1_2;
  const source = { revision: 0, positions: new Float32Array([1, 2, 0]), normals: new Float32Array([unit, unit, 0]),
    tangents: new Float32Array([unit, -unit, 0, 1]), joints: new Uint16Array(4),
    weights: new Float32Array([0.75, 0, 0, 0]), weightMode: "preserve" as const };
  const palette = (revision: number, x: number): SkinningPalette => ({ revision,
    matrices: new Float32Array([-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]),
    normalMatrices: new Float32Array([-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0]) });
  const observations: { revision: number; maxError: number; hasTangents: boolean; historyValid: boolean }[] = [];
  let previous: Float32Array | undefined, scopeOpen = false;
  try {
    device.pushErrorScope("validation"); scopeOpen = true;
    skin.setSource(source, palette(0, 0));
    for (const revision of [0, 1, 2]) {
      const pose = palette(revision, revision * 4);
      if (revision) skin.updatePalette(pose);
      const expected = cpuSkinVertices(prepareSkinningInput(source, pose));
      const encoder = device.createCommandEncoder({ label: "Skin tangent integration" }), output = skin.encode(encoder);
      const stage = history.begin({ ...output, poseRevision: revision });
      history.encode(encoder, stage);
      encoder.copyBufferToBuffer(stage.result.current, 0, readback, 0, 48);
      encoder.copyBufferToBuffer(stage.result.previous, 0, readback, 48, 48);
      device.queue.submit([encoder.finish()]); history.commit(stage);
      await device.queue.onSubmittedWorkDone(); await readback.mapAsync(GPUMapMode.READ);
      const actual = new Float32Array(readback.getMappedRange().slice(0)); readback.unmap();
      const expectedValues = [...expected, ...(previous ?? expected)];
      const maxError = Math.max(...actual.map((value, index) => Math.abs(value - expectedValues[index]!)));
      observations.push({ revision, maxError, hasTangents: output.hasTangents && stage.result.hasTangents,
        historyValid: stage.result.historyValid });
      previous = expected;
    }
    scopeOpen = false; const error = await device.popErrorScope();
    return { action: "gpu-skin-tangent-history", success: !error && observations.every(value => value.maxError < 1e-5 && value.hasTangents)
      && observations[0]!.historyValid === false && observations.slice(1).every(value => value.historyValid),
      observations, ...(error ? { deviceError: error.message } : {}) };
  } finally {
    if (scopeOpen) await device.popErrorScope().catch(() => null);
    history.dispose(); skin.dispose(); session.release(readback);
  }
}
