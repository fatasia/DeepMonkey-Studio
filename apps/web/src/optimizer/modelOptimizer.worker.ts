/// <reference lib="webworker" />

import { inspectModelFile, optimizeModelFile } from "./modelOptimizer";
import { editOptimizerFile } from "./optimizerLayers";
import { OptimizerLayerSession } from "./optimizerLayerSession";
import { optimizerIO } from "./modelOptimizerIO";
import type { ModelOptimizerWorkerRequest, ModelOptimizerWorkerResponse } from "./modelOptimizerWorkerProtocol";

const workerScope = self as DedicatedWorkerGlobalScope;
let layerSession: OptimizerLayerSession | undefined;

workerScope.onmessage = (event: MessageEvent<ModelOptimizerWorkerRequest>) => {
  const request = event.data;
  void runRequest(request);
};

async function runRequest(request: ModelOptimizerWorkerRequest) {
  try {
    if (request.action === "layers-draft" || request.action === "layers-materialize") {
      layerSession ??= new OptimizerLayerSession(await optimizerIO());
      const fresh = await layerSession.open(request.key, request.buffer ? new File([request.buffer], request.name) : undefined);
      if (request.action === "layers-draft") {
        const result = await layerSession.draft(request.edits, fresh);
        workerScope.postMessage({ id: request.id, type: "layers-draft-result", result } satisfies ModelOptimizerWorkerResponse, result.previewBinary ? [result.previewBinary.buffer] : []);
      } else {
        const result = await layerSession.materialize(request.edits);
        workerScope.postMessage({ id: request.id, type: "layers-result", result } satisfies ModelOptimizerWorkerResponse, [result.binary.buffer]);
      }
      return;
    }
    layerSession?.clear();
    layerSession = undefined;
    const file = new File([request.buffer], request.name, { type: request.name.toLowerCase().endsWith(".glb") ? "model/gltf-binary" : "model/gltf+json" });
    if(request.action==="layers"){
      const result=await editOptimizerFile(file,request.edits);
      workerScope.postMessage({id:request.id,type:"layers-result",result} satisfies ModelOptimizerWorkerResponse,[result.binary.buffer]);return;
    }
    if (request.action === "inspect") {
      const result = await inspectModelFile(file);
      post({ id: request.id, type: "inspect-result", result });
      return;
    }
    const result = await optimizeModelFile(file, request.options, (message) => post({ id: request.id, type: "progress", message }), request.copyright);
    workerScope.postMessage({ id: request.id, type: "optimize-result", result } satisfies ModelOptimizerWorkerResponse, [result.binary.buffer]);
  } catch (reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    post({ id: request.id, type: "error", message: error.message, ...(error.stack ? { stack: error.stack } : {}) });
  }
}

function post(message: ModelOptimizerWorkerResponse) {
  workerScope.postMessage(message);
}
