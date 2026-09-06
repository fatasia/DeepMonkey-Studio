import { runConsumerChecks } from "./runtime.js";

const output = document.querySelector("output")!;
try {
  output.textContent = JSON.stringify(await runConsumerChecks(), null, 2);
  output.setAttribute("data-status", "passed");
} catch (error) {
  output.textContent = error instanceof Error ? error.message : String(error);
  output.setAttribute("data-status", "failed");
  throw error;
}
