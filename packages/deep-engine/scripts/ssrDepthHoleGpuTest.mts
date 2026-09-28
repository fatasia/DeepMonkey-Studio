import { createServer } from "node:http";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { SSR_TRACE_WGSL } from "../src/postprocess/screenSpaceReflectionWgsl.ts";
import { traceScreenSpaceReflectionCpu } from "../src/postprocess/screenSpaceReflectionCpu.ts";

const require = createRequire(import.meta.url);
const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" })
  .end('<html><body style="background:#101820;color:#e6ecef;font:16px sans-serif;padding:32px"><h1>SSR GPU depth-hole probe</h1><p id="state"></p><canvas id="mask" width="16" height="16" style="width:512px;height:512px;image-rendering:pixelated;border:1px solid #63737b"></canvas><pre id="result">Running...</pre></body></html>'));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.evaluate("window.__name = (target) => target");
  const results = await page.evaluate(async (wgsl: string) => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("WebGPU adapter unavailable");
    const device = await adapter.requestDevice();
    const shader = device.createShaderModule({ code: wgsl });
    const messages = (await shader.getCompilationInfo()).messages.map(item => `${item.type}: ${item.message}`);
    if (messages.length) throw new Error(messages.join("\n"));
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    const depth = device.createTexture({ size: [32, 32], format: "r32float", usage });
    const normal = device.createTexture({ size: [32, 32], format: "rgba8unorm", usage });
    const color = device.createTexture({ size: [32, 32], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING });
    const trace = device.createTexture({ size: [16, 16], format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const normalBytes = new Uint8Array(256 * 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const offset = y * 256 + x * 4;
      normalBytes.set([128, 13, 184, 0], offset);
    }
    device.queue.writeTexture({ texture: normal }, normalBytes, { bytesPerRow: 256 }, [32, 32]);
    const data = new ArrayBuffer(64), uints = new Uint32Array(data), floats = new Float32Array(data);
    uints.set([32, 32, 16, 16], 0);
    floats.set([Math.tan(Math.PI / 6), 1, 20, 0.5], 4);
    uints.set([32, 4], 8);
    floats.set([0.08, 0.05, 0], 12);
    const params = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(params, 0, data);
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage", minBindingSize: 64 } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: { type: "filtering" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "rgba16float" } },
    ] });
    const pipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: shader, entryPoint: "traceReflection" } });
    const bindings = device.createBindGroup({ layout, entries: [
      { binding: 0, resource: depth.createView() }, { binding: 1, resource: normal.createView() },
      { binding: 2, resource: color.createView() }, { binding: 3, resource: { buffer: params } },
      { binding: 4, resource: device.createSampler({ magFilter: "linear", minFilter: "linear" }) },
      { binding: 5, resource: trace.createView() },
    ] });
    const half = (bits: number) => {
      const exponent = (bits >> 10) & 31, fraction = bits & 1023, sign = bits & 32768 ? -1 : 1;
      return sign * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
    };
    const run = async (hole: boolean) => {
      const bytes = new ArrayBuffer(256 * 32), view = new DataView(bytes);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        view.setFloat32(y * 256 + x * 4, hole && x === 1 && y === 2 ? 0 : 5, true);
      }
      device.queue.writeTexture({ texture: depth }, bytes, { bytesPerRow: 256 }, [32, 32]);
      const readback = device.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.dispatchWorkgroups(2, 2); pass.end();
      encoder.copyTextureToBuffer({ texture: trace }, { buffer: readback, bytesPerRow: 256 }, [16, 16]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const mapped = new DataView(readback.getMappedRange());
      const mask = Array.from({ length: 16 * 16 }, (_, index) =>
        half(mapped.getUint16(Math.floor(index / 16) * 256 + (index % 16) * 8 + 6, true)));
      const alpha = mask[0];
      readback.unmap(); readback.destroy();
      return { alpha, mask };
    };
    const baseline = await run(false), depthHole = await run(true);
    return { adapter: adapter.info.description, baseline: baseline.alpha, depthHole: depthHole.alpha,
      baselineMask: baseline.mask, depthHoleMask: depthHole.mask, messages };
  }, SSR_TRACE_WGSL);
  const depth = new Array(32 * 32).fill(5), normals = new Array(32 * 32 * 3).fill(0);
  for (let pixel = 0; pixel < 32 * 32; pixel++) {
    normals[pixel * 3] = 128 / 255;
    normals[pixel * 3 + 1] = 13 / 255;
    normals[pixel * 3 + 2] = 184 / 255;
  }
  const input = { width: 32, height: 32, depth, normals, color: new Array(32 * 32 * 3).fill(0) };
  const options = { verticalFovRadians: Math.PI / 3, maxDistance: 20, thickness: 0.5,
    steps: 32, refines: 4, edgeFade: 0.08, fresnelF0: 0.05 };
  const cpuBaseline = traceScreenSpaceReflectionCpu(input, options, 0, 0)[3];
  depth[2 * 32 + 1] = 0;
  const cpuDepthHole = traceScreenSpaceReflectionCpu(input, options, 0, 0)[3];
  const show = async (state: string, mask: number[]) => page.evaluate(({ state, mask }) => {
    document.getElementById("state")!.textContent = state;
    const canvas = document.getElementById("mask") as HTMLCanvasElement;
    const context = canvas.getContext("2d")!, image = context.createImageData(16, 16);
    mask.forEach((alpha, index) => {
      image.data[index * 4] = Math.min(255, Math.round(alpha * 4000));
      image.data[index * 4 + 1] = Math.min(255, Math.round(alpha * 800));
      image.data[index * 4 + 2] = Math.min(255, Math.round(alpha * 800));
      image.data[index * 4 + 3] = 255;
    });
    context.putImageData(image, 0, 0);
    document.getElementById("result")!.textContent = `alpha[0,0]: ${mask[0]}`;
  }, { state, mask });
  await show("Solid depth: valid SSR mask", results.baselineMask);
  await page.screenshot({ path: "../../test-output/t03-ssr-solid-depth.png" });
  await show("Depth hole: the false hit must disappear", results.depthHoleMask);
  await page.screenshot({ path: "../../test-output/t03-ssr-depth-hole.png" });
  await writeFile("../../test-output/t03-ssr-gpu.json", JSON.stringify({
    adapter: results.adapter, baseline: results.baseline, depthHole: results.depthHole,
    cpuBaseline, cpuDepthHole,
    messages: results.messages, baselineMask: results.baselineMask, depthHoleMask: results.depthHoleMask,
  }, null, 2));
  console.log({ adapter: results.adapter, baseline: results.baseline, depthHole: results.depthHole,
    cpuBaseline, cpuDepthHole,
    messages: results.messages });
  if (!(results.baseline > 0 && Math.abs(results.baseline - cpuBaseline) < 1e-4
    && results.depthHole === cpuDepthHole && cpuDepthHole === 0 && results.messages.length === 0)) process.exitCode = 1;
} finally { await browser.close(); server.close(); }

