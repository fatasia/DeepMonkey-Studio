/// <reference types="@webgpu/types" />
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { createPbrPipelineSet, type PbrPipelineSet } from "../src/webgpu/pbrPipelineSet.js";
import { resolvePbrRendererFeatures } from "../src/webgpu/pbrRendererFeatures.js";
import { ForwardPlusPbrLightingBindings } from "../src/lighting/pbrLightingBindings.js";
import { snapshotPipelineCompileRecords } from "../src/webgpu/pipelineCompileSnapshot.js";
import { pipelineWarmupEntriesFromLedger } from "../src/webgpu/pipelineCachePersistence.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { sceneShader } from "../src/webgpu/pbrShader.js";

const view = { eye: [0, 2, 5] as const, target: [0, 0, 0] as const, extent: 5,
  background: [0.02, 0.03, 0.05] as const, floor: [0, 0, 0] as const,
  exposure: 1, roughness: .5, width: 16, height: 16, pixelRatio: 1 };

function canvas(): HTMLCanvasElement {
  const value = document.createElement("canvas"); value.width = 16; value.height = 16;
  document.body.append(value); return value;
}

export async function runIC26PipelineCompileProbe() {
  const renderCanvas = canvas();
  let renderer: PbrRenderer | undefined;
  let publicSnapshot;
  try {
    const begin = performance.now();
    renderer = await PbrRenderer.create(renderCanvas, navigator.gpu, new AbortController().signal, {
      pipelines: { firstFrameMainKeys: ["plain/depth/ccw"] },
      features: { environment: false, fog: false, groundGrid: false, ambientOcclusion: false,
        screenSpaceReflection: false, temporalAa: false, bloom: false, textureArrays: false },
    });
    const bootstrapWaitMs = performance.now() - begin;
    const records = renderer.getPipelineCompileRecords();
    const beforeCount = records.length;
    const firstFrame = await renderer.validateFrame(view);
    publicSnapshot = { bootstrapWaitMs, records, snapshotFrozen: Object.isFrozen(records) && records.every(Object.isFrozen),
      retainedCount: beforeCount, firstFrame: { frame: firstFrame.frame, width: firstFrame.width, height: firstFrame.height },
      noErrors: !renderer.session.hasErrors };
    if (!beforeCount || !publicSnapshot.snapshotFrozen || !publicSnapshot.noErrors) throw Error("Public renderer compile snapshot failed");
  } finally { renderer?.dispose(); renderCanvas.remove(); }

  const buildCanvas = canvas();
  const session = await DeviceSession.open(buildCanvas, navigator.gpu, new AbortController().signal);
  let lighting: ForwardPlusPbrLightingBindings | undefined;
  session.device.pushErrorScope("validation");
  let scopeOpen = true;
  try {
    lighting = new ForwardPlusPbrLightingBindings(session);
    const options = { pipelines: { firstFrameMainKeys: ["plain/depth/ccw"] },
      features: { environment: false, fog: false, groundGrid: false, ambientOcclusion: false,
        screenSpaceReflection: false, temporalAa: false, bloom: false, textureArrays: false } };
    const features = resolvePbrRendererFeatures(options.features);
    let coldSet: PbrPipelineSet | undefined;
    const run = async (phase: "cold" | "warm") => {
      const before = snapshotPipelineCompileRecords(session.device), begin = performance.now();
      const build = await createPbrPipelineSet(session, lighting!.layout, options, features);
      const samePipelineSet = phase === "warm" && build === coldSet;
      if (phase === "cold") coldSet = build;
      await build.criticalReady;
      const criticalWaitMs = performance.now() - begin;
      const critical = snapshotPipelineCompileRecords(session.device);
      const retainedLength = critical.length;
      build.release();
      await build.ready;
      const allWaitMs = performance.now() - begin, all = snapshotPipelineCompileRecords(session.device);
      const records = all.slice(before.length);
      const plan = pipelineWarmupEntriesFromLedger(records, build.criticalFingerprints);
      return { phase, samePipelineSet, criticalWaitMs, allWaitMs, criticalRecords: critical.length - before.length,
        allRecords: records.length, cacheHits: records.filter(row => row.cacheHit).length,
        failed: records.filter(row => row.failed).length, records, warmupPlan: plan,
        retainedSnapshotUnchanged: critical.length === retainedLength && Object.isFrozen(critical),
        backgroundRecords: all.length - critical.length };
    };
    const cold = await run("cold"), warm = await run("warm");
    await session.device.queue.onSubmittedWorkDone();
    const validation = await session.device.popErrorScope(); scopeOpen = false;
    const valid = !validation && !session.hasErrors && cold.failed === 0 && warm.failed === 0 &&
      cold.allRecords > 0 && cold.cacheHits === 0 && warm.allRecords === 0 && warm.samePipelineSet &&
      cold.retainedSnapshotUnchanged && warm.retainedSnapshotUnchanged && cold.backgroundRecords > 0 &&
      [cold, warm].every(run => run.records.every(row => Number.isFinite(row.durationMs) && row.durationMs >= 0));
    if (!valid) throw Error(`Actual compile ledger failed ${JSON.stringify({ cold, warm, validation })}`);
    lighting.dispose(); lighting = undefined;
    const resourcesAfterDispose = session.resourceCount;
    if (resourcesAfterDispose !== 0) throw Error(`Pipeline probe leaked ${resourcesAfterDispose} resources`);
    return { passed: true, publicSnapshot, cold, warm, resourcesAfterDispose,
      shaderHash: sha256Utf8(sceneShader), scope: "actual PBR public snapshot, critical/background waits, same-device identical-layout PSO reuse",
      excluded: ["cross-device GPU-object reuse", "frame-time speedup", "compile-duration sum as wall time", "editor Play startup"],
      timingPolicy: "observations only; no fixed speedup threshold, browser/driver caches can affect both rounds" };
  } finally {
    if (scopeOpen) await session.device.popErrorScope();
    lighting?.dispose(); session.dispose(); buildCanvas.remove();
  }
}
