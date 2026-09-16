import { runAuthorBloomGpuProbe } from "./authorBloomGpuProbe.js";
const output = document.createElement("pre"); output.textContent = "Running author Bloom GPU readback…"; document.body.append(output);
void runAuthorBloomGpuProbe().then(result => {
  output.textContent = JSON.stringify(result, null, 2); document.title = result.success ? "Author Bloom GPU PASS" : "Author Bloom GPU FAIL";
}).catch((error: unknown) => { output.textContent = String(error); document.title = "Author Bloom GPU ERROR"; });
