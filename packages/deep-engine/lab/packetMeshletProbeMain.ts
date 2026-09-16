import { runLocalSpotLodProbe } from "./localSpotLodProbe.js";
const output = document.querySelector("pre")!, canvases = [document.createElement("canvas"), document.createElement("canvas")];
canvases.forEach(canvas => { canvas.width = 128; canvas.height = 128; document.body.append(canvas); });
try {
  const resident = new URLSearchParams(location.search).has("resident");
  const spot = await runLocalSpotLodProbe(canvases[0]!, canvases[1]!, true, false, resident);
  const directional = await runLocalSpotLodProbe(canvases[0]!, canvases[1]!, true, true, resident);
  output.textContent = JSON.stringify({ passed: spot.passed && directional.passed, spot, directional }, null, 2);
  document.title = spot.passed && directional.passed ? "Packet Meshlet PASS" : "Packet Meshlet FAIL";
} catch (error) { output.textContent = String(error); document.title = "Packet Meshlet ERROR"; }
finally { canvases.forEach(canvas => canvas.remove()); }
