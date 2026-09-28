import { createServer } from "node:http";
import { createRequire } from "node:module";
import { OIT_REACTIVE_MASK_WGSL } from "../src/webgpu/oitReactiveMaskWgsl.ts";

const require = createRequire(import.meta.url);
const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" }); response.end("<html><body>GPU</body></html>");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async code => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("WebGPU adapter unavailable");
    const device = await adapter.requestDevice();
    try {
      const module = device.createShaderModule({ code });
      const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === "error");
      if (errors.length) throw new Error(errors.map(message => message.message).join("; "));
      const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float" } }] });
      const pipeline = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: "reactiveVertex" },
        fragment: { module, entryPoint: "reactiveFragment", targets: [{ format: "r8unorm" }] },
        primitive: { topology: "triangle-list" } });
      const width = 4, height = 4;
      const revealage = device.createTexture({ size: [width, height], format: "r16float",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      // f16(0.5) = 0x3800, uniform coverage should be 0.5.
      const half = new Uint16Array(16).fill(0x3800);
      device.queue.writeTexture({ texture: revealage }, half,
        { bytesPerRow: 8, rowsPerImage: height }, [width, height]);
      const mask = device.createTexture({ size: [width, height], format: "r8unorm",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
      const bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: revealage.createView() }] });
      const out = device.createBuffer({ size: 256 * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: mask.createView(), loadOp: "clear", storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
      encoder.copyTextureToBuffer({ texture: mask }, { buffer: out, bytesPerRow: 256, rowsPerImage: height }, [width, height]);
      device.queue.submit([encoder.finish()]); await out.mapAsync(GPUMapMode.READ);
      const values = new Uint8Array(out.getMappedRange()).slice(0, 4); out.unmap();
      for (const resource of [revealage, mask, out]) resource.destroy();
      return { rgba: [...values], compiled: true };
    } finally { device.destroy(); }
  }, OIT_REACTIVE_MASK_WGSL);
  if (!result.compiled || result.rgba[0] < 126 || result.rgba[0] > 129) throw new Error(`OIT 掩码读回不符：${JSON.stringify(result)}`);
  console.log(JSON.stringify({ verdict: "pass", ...result }));
} finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
