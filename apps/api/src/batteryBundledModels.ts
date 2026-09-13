import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BatteryModelCatalogEntry, BatteryOnnxEquivalenceManifest } from "@bim-studio/contracts";
import { BATTERY_MODEL_CATALOG } from "@bim-studio/contracts";
import { verifyFile, verifyRuntimeAdapterResources, type BatteryOnnxDeployment } from "./batteryOnnxDeployment.js";
import type { FormalBatteryModel } from "./batteryModelGateway.js";

export const BUNDLED_BATTERY_ROOT = fileURLToPath(new URL("../models/battery/", import.meta.url));
const MODELS: FormalBatteryModel[] = ["bmsformer", "socformer", "batterymformer"];

/** 本地验证制品与生产批准清单分开加载；从不改写 candidate 的批准身份。 */
export async function loadBundledBatteryModels(root = BUNDLED_BATTERY_ROOT): Promise<BatteryOnnxDeployment> {
  const manifests = JSON.parse(await readFile(resolve(root, "candidate-manifests.json"), "utf8")) as BatteryOnnxEquivalenceManifest[];
  if (!Array.isArray(manifests) || manifests.length !== MODELS.length) throw new Error("内置电池模型清单不完整");
  const deployment: BatteryOnnxDeployment = { enabled: true, mode: "local-validation", artifactRoot: root, requestedModels: [...MODELS], manifests, models: {}, diagnostics: ["项目内置 ONNX 本地验证推理；未获生产批准，不请求外部业务服务"] };
  for (const model of MODELS) {
    const manifest = manifests.find(item => item.modelId === `battery.${model}`);
    if (!manifest || manifest.schemaVersion !== 1 || manifest.approval.decisionStatus !== "candidate"
      || manifest.artifact.opset !== 18 || manifest.artifact.precision !== "fp32") throw new Error(`${model} 内置候选身份无效`);
    for (const descriptor of [manifest.artifact, manifest.runtimeAdapter]) {
      if (!descriptor.fileName || basename(descriptor.fileName) !== descriptor.fileName || descriptor.fileName === "..") throw new Error("内置电池制品路径越界");
      await verifyFile(resolve(root, descriptor.fileName), descriptor.sizeBytes, descriptor.sha256, "内置电池制品", 256 * 1024 * 1024);
    }
    const artifactPath = resolve(root, manifest.artifact.fileName), runtimeAdapterPath = resolve(root, manifest.runtimeAdapter.fileName);
    await verifyRuntimeAdapterResources(runtimeAdapterPath, root, manifest);
    deployment.models[model] = { manifest, artifactPath, runtimeAdapterPath };
  }
  return deployment;
}

export function bundledBatteryCatalog(): BatteryModelCatalogEntry[] {
  return BATTERY_MODEL_CATALOG.filter(item => item.role === "primary-model").map(item => ({ ...item,
    runtime: "onnx", status: "active-shadow", outputAuthority: "advisory", productionTraffic: 0, productionEligible: false,
    executionMode: "observe-compare-audit", sourceCheckpoint: `models/battery/${item.family}.fp32.opset18.onnx`,
    evidence: { gate: "research", passed: false, source: "project-bundled-onnx", summary: "项目内置模型可执行真实本地推理，结果用于验证；生产批准尚未完成。" },
  }));
}
