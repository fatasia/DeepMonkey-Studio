/// <reference types="@webgpu/types" />
import { PbrRenderer, type PbrRendererOptions, type RenderView } from "../src/webgpu/pbrRenderer.js";
import { materializeRuntimeRenderPacket } from "../src/runtimePackage/renderPacket.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { readIntegrationAttachments } from "./pbrDeformationIntegrationProbeReadback.js";

interface Manifest { packageHash: string; packetHash: string; phases: string[];
  lostTimeoutMs: number; frameTimeoutMs: number }
interface PackageInput { packageHash: { value: string }; entrypoints: { renderPacket: string }; payloads: Record<string, unknown> }
const options: PbrRendererOptions = { shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
  features: { environment: false, groundPlane: false, groundGrid: false, ambientOcclusion: false,
    temporalAa: false, occlusionCulling: false, bloom: false, vignette: false, fog: false } };
const view: RenderView = { width: 128, height: 128, pixelRatio: 1, eye: [0, 0, 8], target: [0, 0, 0],
  up: [0, 1, 0], extent: 8, verticalFovRadians: 1, near: .1, far: 100,
  background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: .8 };

async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Error(`${label} timed out`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

async function firstFrame(renderer: PbrRenderer, timeout: number) {
  const metrics = await bounded(renderer.validateFrame(view), timeout, "production first frame");
  const values = await bounded(readIntegrationAttachments(renderer, undefined, false), timeout, "production HDR/CSM readback");
  const background = values.slice(0, 3);
  if (background.some(value => Math.abs(value) > .001)) throw Error("Recovery fixture corner must match the black production background");
  let coloredPixels = 0;
  for (let pixel = 0; pixel < 128 * 128; pixel++)
    if (background.some((clear, lane) => Math.abs(values[pixel * 8 + lane]! - clear) > .001)) coloredPixels++;
  if (!values.every(Number.isFinite) || coloredPixels <= 32 || metrics.frame < 1 || metrics.drawCalls < 1 || metrics.triangles < 1)
    throw Error("Production first frame is invalid or empty");
  return { values, coloredPixels, frame: metrics.frame };
}

export async function runJ3DeviceRecoveryProbe(canvas: HTMLCanvasElement, manifest: Manifest, source: PackageInput,
  observeFrame?: (round: number, phase: "before" | "after") => Promise<void>) {
  const payload = source.payloads[source.entrypoints.renderPacket];
  const packetHash = sha256Utf8(JSON.stringify(payload));
  if (source.packageHash.value !== manifest.packageHash || packetHash !== manifest.packetHash) throw Error("Recovery manifest source mismatch");
  const packet = materializeRuntimeRenderPacket(payload, "$.recoveryPacket");
  const runs = [];
  for (let round = 0; round < 2; round++) {
    const phases: string[] = [], abort = new AbortController();
    let renderer: PbrRenderer | undefined;
    const record = (phase: string) => phases.push(phase);
    try {
      renderer = await bounded(PbrRenderer.create(canvas, navigator.gpu, abort.signal, options), manifest.frameTimeoutMs, "initial device");
      const oldDevice = renderer.session.device; record("initial-device");
      await bounded(renderer.setPacketValidated(packet, abort.signal), manifest.frameTimeoutMs, "initial upload"); record("uploaded");
      const before = await firstFrame(renderer, manifest.frameTimeoutMs); record("first-valid-frame");
      await observeFrame?.(round, "before");
      const liveResourcesAtLoss = renderer.session.resourceCount;
      if (liveResourcesAtLoss <= 0) throw Error("No production renderer resources were resident at loss injection");
      oldDevice.destroy();
      const loss = await bounded(oldDevice.lost, manifest.lostTimeoutMs, "actual device lost");
      await Promise.resolve();
      if (loss.reason !== "destroyed" || renderer.session.state !== "lost" || renderer.render(view) !== undefined)
        throw Error("Destroyed old device did not stop the production renderer");
      record("lost-observed");
      renderer.dispose();
      if (renderer.session.resourceCount !== 0 || renderer.session.resourceMemory.estimatedBytes !== 0)
        throw Error("Old session ownership was not retired");
      renderer = undefined; record("old-host-retired");
      renderer = await bounded(PbrRenderer.create(canvas, navigator.gpu, abort.signal, options), manifest.frameTimeoutMs, "recreated device");
      if (renderer.session.device === oldDevice) throw Error("Recovered host reused the lost device");
      record("recreated");
      await bounded(renderer.setPacketValidated(packet, abort.signal), manifest.frameTimeoutMs, "recovery upload"); record("uploaded");
      const after = await firstFrame(renderer, manifest.frameTimeoutMs); record("first-valid-frame");
      await observeFrame?.(round, "after");
      let maxError = 0;
      for (let index = 0; index < before.values.length; index++)
        maxError = Math.max(maxError, Math.abs(before.values[index]! - after.values[index]!));
      if (maxError !== 0) throw Error(`Recovered production first-frame attachments changed: ${maxError}`);
      renderer.dispose();
      const resourcesAfter = renderer.session.resourceCount, bytesAfter = renderer.session.resourceMemory.estimatedBytes;
      if (resourcesAfter !== 0 || bytesAfter !== 0) throw Error("Recovered session did not dispose cleanly");
      renderer = undefined; record("disposed");
      if (JSON.stringify(phases) !== JSON.stringify(manifest.phases)) throw Error("Recovery phase contract drift");
      runs.push({ phases, lossReason: loss.reason, newDevice: true, firstFrameValid: true,
        firstFrameStable: true, liveComponentsAtLoss: liveResourcesAtLoss > 0, liveResourcesAtLoss,
        coloredPixels: before.coloredPixels, maxError, resourcesAfter, ownedEstimatedBytesAfter: bytesAfter });
    } finally { abort.abort(); renderer?.dispose(); }
  }
  return { host: "webgpu-pbr-renderer", packageHash: manifest.packageHash, packetHash, runs,
    passed: true, scope: "actual destroyed-device host reopen + production PBR components; not automatic unknown-loss recovery" };
}
