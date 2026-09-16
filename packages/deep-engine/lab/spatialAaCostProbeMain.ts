import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { runSpatialAaCostProbe } from "./spatialAaCostProbe.js";
const output = document.querySelector("pre")!, canvas = document.createElement("canvas");
canvas.width = 64; canvas.height = 32; document.body.append(canvas);
let session: DeviceSession | undefined;
try {
  session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const result = await runSpatialAaCostProbe(session), diagnostics = session.diagnostics;
  const success = result.status === "measured" && result.resourceDelta === 0 && diagnostics.length === 0 && session.adapterInfo?.isFallbackAdapter === false;
  output.textContent = JSON.stringify({ ...result, success, remainingResources: session.resourceCount, diagnostics }, null, 2);
  document.title = success ? "Spatial AA Cost PASS" : `Spatial AA Cost ${result.status}`;
} catch (error) { output.textContent = String(error); document.title = "Spatial AA Cost ERROR"; }
finally { session?.dispose(); canvas.remove(); }
