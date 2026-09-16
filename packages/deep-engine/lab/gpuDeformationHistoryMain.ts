import { runGpuDeformationHistoryProbe } from "./gpuDeformationHistoryProbe.js";
const output = document.createElement("pre"); output.textContent = "Running GPU deformation history readback…"; document.body.append(output);
void runGpuDeformationHistoryProbe().then(result => {
  output.textContent = JSON.stringify(result, null, 2); document.title = result.success ? "GPU History PASS" : "GPU History FAIL";
}).catch((error: unknown) => { output.textContent = String(error); document.title = "GPU History ERROR"; });
