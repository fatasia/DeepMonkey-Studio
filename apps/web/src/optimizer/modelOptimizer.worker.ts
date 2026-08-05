/// <reference lib="webworker" />

import { inspectModelFile, optimizeModelFile } from "./modelOptimizer";
import type { ModelOptimizerWorkerRequest, ModelOptimizerWorkerResponse } from "./modelOptimizerWorkerProtocol";

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<ModelOptimizerWorkerRequest>) => {
  const request = event.data;
  void runRequest(request);
};

async function runRequest(request: ModelOptimizerWorkerRequest) {
  try {
    const file = new File([request.buffer], request.name, { type: request.name.toLowerCase().endsWith(".glb") ? "model/gltf-binary" : "model/gltf+json" });
    if (request.action === "inspect") {
      const result = await inspectModelFile(file);
      post({ id: request.id, type: "inspect-result", result });
      return;
    }
    const result = await optimizeModelFile(file, request.options, (message) => post({ id: request.id, type: "progress", message }));
    workerScope.postMessage({ id: request.id, type: "optimize-result", result } satisfies ModelOptimizerWorkerResponse, [result.binary.buffer]);
  } catch (reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    post({ id: request.id, type: "error", message: error.message, ...(error.stack ? { stack: error.stack } : {}) });
  }
}

function post(message: ModelOptimizerWorkerResponse) {
  workerScope.postMessage(message);
}
