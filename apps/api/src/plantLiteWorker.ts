import { parentPort } from "node:worker_threads";
import type { PlantLiteStudyRecord, PlantLiteStudyRequest } from "@bim-studio/contracts";
import { runPlantLiteStudy } from "./plantLiteStudy.js";

interface PlantLiteWorkerRequest {
  projectId: string;
  request: PlantLiteStudyRequest;
  now?: string;
}

type PlantLiteWorkerResponse =
  | { type: "result"; record: PlantLiteStudyRecord }
  | { type: "error"; message: string };

const port = parentPort;
if (!port) throw new Error("Plant Lite Worker 必须由 worker_threads 启动");

port.on("message", (payload: PlantLiteWorkerRequest) => {
  let response: PlantLiteWorkerResponse;
  try {
    response = { type: "result", record: runPlantLiteStudy(payload.projectId, payload.request, payload.now) };
  } catch (error) {
    response = { type: "error", message: compactError(error) };
  }
  port.postMessage(response);
});

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "Plant Lite Worker 失败";
}
