import { runLocalSpotLodProbe } from "./localSpotLodProbe.js";
const output = document.querySelector("pre")!, canvases = [document.createElement("canvas"), document.createElement("canvas")];
canvases.forEach(canvas => { canvas.width = 128; canvas.height = 128; document.body.append(canvas); });
try { const result = await runLocalSpotLodProbe(canvases[0]!, canvases[1]!); output.textContent = JSON.stringify(result, null, 2);
  document.title = result.passed ? "Local Spot LOD PASS" : "Local Spot LOD FAIL";
} catch (error) { output.textContent = String(error); document.title = "Local Spot LOD ERROR"; }
finally { canvases.forEach(canvas => canvas.remove()); }
