import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { createPipelines } from "../src/webgpu/pipelines.js";
import { ForwardPlusPbrLightingBindings } from "../src/lighting/pbrLightingBindings.js";
import { runPbrDeformationDrawProbe } from "./pbrDeformationDrawProbe.js";

/** Real device pipeline validation plus fixed-pose plain/unlit draw and readback. */
export async function runPbrDeformationPipelineProbe() {
  const canvas = document.createElement("canvas");
  canvas.width = 16; canvas.height = 16; document.body.append(canvas);
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  let lighting: ForwardPlusPbrLightingBindings | undefined;
  const device = session.device;
  device.pushErrorScope("validation");
  let scopeOpen = true;
  try {
    lighting = new ForwardPlusPbrLightingBindings(session);
    const pipelines = await createPipelines(device, navigator.gpu.getPreferredCanvasFormat(), lighting.layout,
      true, false, true, { deformation: true });
    const main = [...pipelines.mainPipelines.keys()], shadow = [...pipelines.shadowPipelines.keys()];
    if (main.length !== 18 || shadow.length !== 18 || !pipelines.deformationPlainLayout) {
      throw new Error(`Incomplete deformation pipeline family: main=${main.length}, shadow=${shadow.length}.`);
    }
    let rejectedMissingMotion = false;
    try {
      await createPipelines(device, navigator.gpu.getPreferredCanvasFormat(), lighting.layout,
        false, false, true, { deformation: true });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("geometry buffers")) throw error;
      rejectedMissingMotion = true;
    }
    // Bind the actual plain storage layout, including the minimum 48-byte pose stride.
    const current = session.own(device.createBuffer({ size: 48, usage: GPUBufferUsage.STORAGE }));
    const previous = session.own(device.createBuffer({ size: 48, usage: GPUBufferUsage.STORAGE }));
    device.createBindGroup({ layout: pipelines.deformationPlainLayout, entries: [
      { binding: 11, resource: { buffer: current } }, { binding: 12, resource: { buffer: previous } },
    ] });
    const draw = [];
    for (const kind of ["skin", "morph", "morph-skin"] as const) draw.push(await runPbrDeformationDrawProbe(session, kind));
    await device.queue.onSubmittedWorkDone();
    const validation = await device.popErrorScope();
    scopeOpen = false;
    if (validation) throw new Error(validation.message);
    session.release(current); session.release(previous); lighting.dispose();
    return { success: draw.every(result => result.passed) && rejectedMissingMotion && !session.hasErrors && session.resourceCount === 0,
      scope: "Real GPU pipeline creation and plain unlit deformation draw/readback", draw,
      adapter: session.adapterInfo, main, shadow, rejectedMissingMotion,
      poseBindings: [11, 12], poseStride: 48, resourcesAfterDispose: session.resourceCount,
      diagnostics: session.diagnostics };
  } finally {
    try { if (scopeOpen) await device.popErrorScope(); }
    finally { try { lighting?.dispose(); } finally { session.dispose(); canvas.remove(); } }
  }
}
