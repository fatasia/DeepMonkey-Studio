import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { runSpatialAaProbe } from "./spatialAaProbe.js";
const output = document.querySelector("pre")!, canvas = document.createElement("canvas");
canvas.width = 64; canvas.height = 32; document.body.append(canvas);
let session: DeviceSession | undefined;
try {
  session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const result = await runSpatialAaProbe(session), remainingResources = session.resourceCount, diagnostics = session.diagnostics;
  const success = result.success && remainingResources === 0 && diagnostics.length === 0 && session.adapterInfo?.isFallbackAdapter === false;
  output.textContent = JSON.stringify({ ...result, success, adapter: session.adapterInfo, remainingResources, diagnostics }, null, 2);
  document.title = success ? "Spatial AA PASS" : "Spatial AA FAIL";
} catch (error) { output.textContent = String(error); document.title = "Spatial AA ERROR"; }
finally { session?.dispose(); canvas.remove(); }
