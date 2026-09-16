import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { runAuthorLodFrustumProbe } from "./authorLodFrustumProbe.js";
const output = document.querySelector("pre")!, canvas = document.createElement("canvas");
canvas.width = 32; canvas.height = 32; document.body.append(canvas);
let session: DeviceSession | undefined;
try {
  session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  const result = await runAuthorLodFrustumProbe(session);
  const success = result.success && session.resourceCount === 0 && session.diagnostics.length === 0 && session.adapterInfo?.isFallbackAdapter === false;
  output.textContent = JSON.stringify({ ...result, success, remainingResources: session.resourceCount, diagnostics: session.diagnostics, adapter: session.adapterInfo }, null, 2);
  document.title = success ? "Author Frustum PASS" : "Author Frustum FAIL";
} catch (error) { output.textContent = String(error); document.title = "Author Frustum ERROR"; }
finally { session?.dispose(); canvas.remove(); }
