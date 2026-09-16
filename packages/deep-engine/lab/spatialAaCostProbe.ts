/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { GpuTimer } from "../src/webgpu/gpuTimer.js";
import { SPATIAL_AA_PRESENT_WGSL } from "../src/postprocess/spatialAaWgsl.js";

const GROUP_PASSES = 32, WARMUP_PASSES = 20, SAMPLE_GROUPS = 15;
export function summarizeSpatialAaCost(groups: readonly number[], passes = GROUP_PASSES) {
  if (!groups.length || groups.some(v => !Number.isFinite(v) || v < 0) || !Number.isSafeInteger(passes) || passes < 1) throw Error("Invalid GPU timing samples.");
  // Same nearest-rank definition as competitiveBenchmarkRunner.
  const sorted = groups.map(v => v / passes).sort((a, b) => a - b);
  return { medianMs: sorted[Math.ceil(sorted.length * .5) - 1]!, p95Ms: sorted[Math.ceil(sorted.length * .95) - 1]!,
    zeroGroups: groups.filter(v => v === 0).length, groups: groups.length, passesPerGroup: passes, rawGroupMilliseconds: [...groups] };
}
export interface SpatialAaCostCase {
  readonly width: number; readonly height: number; readonly load: "flat" | "geometry-edge";
  readonly copy: ReturnType<typeof summarizeSpatialAaCost>; readonly aa: ReturnType<typeof summarizeSpatialAaCost>;
  readonly medianDeltaMs: number; readonly targetBytes: number; readonly productionIntermediateIncrementBytes: number;
}
export async function runSpatialAaCostProbe(session: DeviceSession) {
  const device = session.device, baseline = session.resourceCount;
  if (session.state !== "ready") throw Error("Spatial AA cost probe requires a ready session.");
  const context = { adapter: session.adapterInfo, format: session.format, warmupPassesPerMode: WARMUP_PASSES,
    sampleGroupsPerMode: SAMPLE_GROUPS, passesPerGroup: GROUP_PASSES,
    scope: "GPU timestamps spanning repeated fullscreen passes, normalized per pass; same encoded 8-bit source/output and linear clamp sampler. Copy is a fullscreen sample pass, not copyTextureToTexture.",
    limitations: "Warm-cache synthetic flat/slanted geometry-edge images, not whole-frame rendering, tone mapping, upload, canvas acquire, or UI. AA requires an additional 4B/pixel production intermediate. No CPU wall-clock GPU estimates." };
  if (!device.features.has("timestamp-query")) return { ...context, status: "unsupported" as const, cases: [], reason: "timestamp-query unavailable", resourceDelta: 0 };
  if (session.format !== "rgba8unorm" && session.format !== "bgra8unorm") throw Error("Cost probe requires non-sRGB 8-bit format.");
  const owned: Array<GPUTexture | GPUBuffer | GPUQuerySet> = [];
  const own = <T extends GPUTexture | GPUBuffer | GPUQuerySet>(value: T): T => { owned.push(session.own(value)); return value; };
  // Reuse the production timer ABI and readback scheduling while tracking its owned diagnostic resources.
  const timerSession = { device, get state() { return session.state; }, own } as unknown as DeviceSession;
  const timer = new GpuTimer(timerSession); timer.enabled = true;
  let scopeOpen = false, serial = 0;
  try {
    device.pushErrorScope("validation"); scopeOpen = true;
    const copyCode = SPATIAL_AA_PRESENT_WGSL.replace("return deepSpatialAa(v.uv);", "return deepSpatialAaSample(v.uv);");
    const pipeline = async (code: string) => {
      const module = device.createShaderModule({ code });
      const info = await module.getCompilationInfo();
      if (info.messages.some(m => m.type === "error")) throw Error(info.messages.map(m => m.message).join("\n"));
      return device.createRenderPipelineAsync({ layout: "auto", vertex: { module, entryPoint: "vertexMain" },
        fragment: { module, entryPoint: "fragmentMain", targets: [{ format: session.format }] }, primitive: { topology: "triangle-list" } });
    };
    const copy = await pipeline(copyCode), aa = await pipeline(SPATIAL_AA_PRESENT_WGSL);
    const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    const cases: SpatialAaCostCase[] = [];
    for (const [width, height] of [[1280, 720], [1920, 1080]] as const) for (const load of ["flat", "geometry-edge"] as const) {
      const input = own(device.createTexture({ size: [width, height], format: session.format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
      const output = own(device.createTexture({ size: [width, height], format: session.format, usage: GPUTextureUsage.RENDER_ATTACHMENT }));
      const bytes = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const value = load === "flat" ? 102 : ((x + .61 * y) % 96 < 45 && (y + .23 * x) % 128 < 112) ? 230 : 26;
        bytes.set([value, value, value, 255], (y * width + x) * 4);
      }
      device.queue.writeTexture({ texture: input }, bytes, { bytesPerRow: width * 4 }, [width, height]);
      const inputView = input.createView(), target = output.createView();
      const bind = (p: GPURenderPipeline) => device.createBindGroup({ layout: p.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: inputView }, { binding: 1, resource: sampler }] });
      const copyBinding = bind(copy), aaBinding = bind(aa);
      const batch = async (p: GPURenderPipeline, binding: GPUBindGroup, count: number, measured: boolean) => {
        const frame = ++serial, timed = measured ? timer.begin(frame) : undefined;
        if (measured && !timed) throw Error("GPU timing slot unavailable.");
        const encoder = device.createCommandEncoder();
        for (let i = 0; i < count; i++) {
          const timestamps = timed && (i === 0 || i === count - 1) ? { querySet: timed.queries,
            ...(i === 0 ? { beginningOfPassWriteIndex: 0 } : {}), ...(i === count - 1 ? { endOfPassWriteIndex: 1 } : {}) } : undefined;
          const pass = encoder.beginRenderPass({ ...(timestamps ? { timestampWrites: timestamps } : {}),
            colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store" }] });
          pass.setPipeline(p); pass.setBindGroup(0, binding); pass.draw(3); pass.end();
        }
        timed?.resolve(encoder); device.queue.submit([encoder.finish()]);
        if (!timed) { await device.queue.onSubmittedWorkDone(); return 0; }
        timed.read(); const result = await timer.collect(frame, frame);
        if (result.length !== 1 || timer.diagnostics.length) throw Error(`GPU timestamps failed: ${timer.diagnostics.join("; ")}`);
        return result[0]!.milliseconds;
      };
      await batch(copy, copyBinding, WARMUP_PASSES, false); await batch(aa, aaBinding, WARMUP_PASSES, false);
      const copyTimes: number[] = [], aaTimes: number[] = [];
      for (let i = 0; i < SAMPLE_GROUPS; i++) {
        if (i % 2 === 0) { copyTimes.push(await batch(copy, copyBinding, GROUP_PASSES, true)); aaTimes.push(await batch(aa, aaBinding, GROUP_PASSES, true)); }
        else { aaTimes.push(await batch(aa, aaBinding, GROUP_PASSES, true)); copyTimes.push(await batch(copy, copyBinding, GROUP_PASSES, true)); }
      }
      const copyStats = summarizeSpatialAaCost(copyTimes), aaStats = summarizeSpatialAaCost(aaTimes);
      cases.push({ width, height, load, copy: copyStats, aa: aaStats, medianDeltaMs: aaStats.medianMs - copyStats.medianMs,
        targetBytes: width * height * 8, productionIntermediateIncrementBytes: width * height * 4 });
      session.release(input); session.release(output);
    }
    scopeOpen = false; const error = await device.popErrorScope(); if (error) throw Error(error.message);
    for (const resource of owned) session.release(resource);
    return { ...context, status: cases.some(c => c.copy.zeroGroups || c.aa.zeroGroups) ? "insufficient-timestamp-resolution" as const : "measured" as const,
      cases, resourceDelta: session.resourceCount - baseline };
  } finally { for (const resource of owned) session.release(resource); if (scopeOpen) await device.popErrorScope(); }
}
