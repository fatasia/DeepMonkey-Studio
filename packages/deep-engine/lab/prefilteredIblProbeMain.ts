import { runPrefilteredIblProbe } from "./prefilteredIblProbe.js";
try {
  const result = await runPrefilteredIblProbe(document.querySelector("canvas")!);
  document.querySelector("pre")!.textContent = JSON.stringify(result, null, 2);
  document.title = result.passed ? "Prefiltered IBL PASS" : "Prefiltered IBL FAIL";
} catch (error) {
  document.querySelector("pre")!.textContent = String(error); document.title = "Prefiltered IBL ERROR";
}
