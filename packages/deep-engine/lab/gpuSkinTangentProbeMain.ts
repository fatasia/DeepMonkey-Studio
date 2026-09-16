import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { runGpuSkinTangentProbe } from "./gpuSkinTangentProbe.js";

const output = document.querySelector("pre")!;
const canvas = document.createElement("canvas");
canvas.width = 32; canvas.height = 32;
document.body.append(canvas);
let session: DeviceSession | undefined;
try {
  session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const result = await runGpuSkinTangentProbe(session);
  const remainingResources = session.resourceCount;
  const diagnostics = session.diagnostics;
  const success = result.success && remainingResources === 0 && diagnostics.length === 0
    && session.adapterInfo?.isFallbackAdapter === false;
  output.textContent = JSON.stringify({ ...result, success, adapter: session.adapterInfo,
    remainingResources, diagnostics }, null, 2);
  document.title = success ? "Skin Tangent PASS" : "Skin Tangent FAIL";
} catch (error) {
  output.textContent = String(error); document.title = "Skin Tangent ERROR";
} finally { session?.dispose(); canvas.remove(); }
