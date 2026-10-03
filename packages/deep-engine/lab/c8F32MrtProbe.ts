import * as THREE from "three";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { prepareF32MrtObservation, decodeF32Witness } from "./c8F32MrtDevice.js";
import { type F32WitnessMode } from "./c8F32MrtShader.js";
import { runSharedSceneProbe } from "./c8SharedSceneProbe.js";
import { observeThreeFragment } from "./c8FragmentObservablesShader.js";

export async function runF32MrtWitness(mode: F32WitnessMode) {
  const observer = prepareF32MrtObservation(mode, navigator.gpu), actualThreeHashes: string[] = [];
  const frameNames = ["strict-emissive/front/exposure-0.5", "strict-emissive/oblique/exposure-0.5", "direct-diagnostic/front/exposure-0.5", "direct-diagnostic/oblique/exposure-0.5"];
  let hookCount = 0;
  try {
    const run = await runSharedSceneProbe({ cameraScale: .6, exposures: [.5], directProfile: "three-r185", gpu: observer.gpu,
      observeThreePrograms(renderer: THREE.WebGLRenderer) {
        const name = frameNames[hookCount++]; if (!name) throw Error(`F32 witness unexpected explicit-frame hook ${hookCount}`);
        // Reuse the pinned original RE/chunk seam checks without installing its observation output.
        observeThreeFragment("single", THREE.ShaderChunk);
        const originalRe = THREE.ShaderChunk.lights_physical_pars_fragment.match(/^void RE_Direct_Physical\([^]*?^\}/m)?.[0];
        const gl = renderer.getContext();
        for (const program of renderer.info.programs ?? []) {
          const source = gl.getShaderSource(program.fragmentShader);
          if (!source || !originalRe || !source.includes(originalRe) || source.includes("deepObservedFragment") || source.includes("C8 isolated")) throw Error("F32 witness requires original Three full fragment");
          actualThreeHashes.push(sha256Utf8(source));
        }
        observer.armFrame(name);
      } });
    const snapshots = await observer.snapshots();
    const receipt = observer.receipt(), observations = receipt.passes.filter(pass => pass.phase === "observed"), validations = receipt.passes.filter(pass => pass.phase === "validation");
    if (observations.length !== run.frames.length || hookCount !== run.frames.length || observations.some((pass, index) => pass.name !== run.frames[index]!.name)) throw Error(`F32 witness named frame receipt mismatch: ${JSON.stringify({ snapshots: snapshots.length, runFrames: run.frames.length, hookCount, compileHashes: actualThreeHashes.length, observer: receipt, frameNames: run.frames.map(frame => frame.name), snapshotFrameIds: snapshots.map(snapshot => snapshot.frameId) })}`);
    if (actualThreeHashes.length < 1) throw Error(`F32 witness compile receipt missing: ${JSON.stringify({ snapshots: snapshots.length, runFrames: run.frames.length, compileHashes: actualThreeHashes.length, observer: observer.receipt() })}`);
    function capture(pass: typeof receipt.passes[number]) {
      const found = snapshots.filter(snapshot => snapshot.frameId === pass.frameId);
      if (found.length !== 1) throw Error(`F32 witness named pass ${pass.frameId} has ${found.length} snapshots`);
      const snapshot = found[0]!;
      return { name: pass.name, phase: pass.phase, frameId: snapshot.frameId, resourceId: snapshot.resourceId, width: snapshot.width, height: snapshot.height, format: snapshot.format, bytesPerRow: snapshot.bytesPerRow, rgba: decodeF32Witness(snapshot) };
    }
    return { run, witness: observations.map(capture), validationWitness: validations.map(capture),
      receipt: { ...receipt, hookCount, three: { format: "rgba32float", observable: "original-full", actualCompiledFragmentHashes: [...new Set(actualThreeHashes)], compileObservations: actualThreeHashes.length } } };
  } finally { observer.dispose(); }
}
