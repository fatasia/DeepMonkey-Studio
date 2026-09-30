import fixture from "../fixtures/display-parity-v1.json";
import { displayColorLibrary } from "../src/shader/displayColorBackends.js";
import { outputShader } from "../src/webgpu/pbrOutputShader.js";
import { prepareHdrEnvironmentUpload } from "../src/textures/hdrEnvironmentUpload.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";

const { width, height, colors } = fixture;
const input = new Float32Array(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
  input.set(colors[Math.floor(x / 4)]!, (y * width + x) * 4);

const vertex = `@vertex fn vs(@builtin(vertex_index) i:u32) -> @builtin(position) vec4f {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}`;

async function gpuPixels(device: GPUDevice, settings: readonly number[], production: boolean) {
  device.pushErrorScope("validation");
  const resources: Array<{ destroy(): void }> = [];
  try {
    const source = device.createTexture({ size: [width, height], format: production ? "rgba16float" : "rgba32float",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING }); resources.push(source);
    if (production) {
      const rgb = new Float32Array(width * height * 3);
      for (let i = 0; i < width * height; i++) rgb.set(input.subarray(i*4,i*4+3),i*3);
      const half = prepareHdrEnvironmentUpload({ width, height, data: rgb });
      device.queue.writeTexture({ texture: source }, half.data, { bytesPerRow: half.bytesPerRow }, [width, height]);
    } else device.queue.writeTexture({ texture: source }, input, { bytesPerRow: width * 16 }, [width, height]);
    const buffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); resources.push(buffer);
    device.queue.writeBuffer(buffer, 0, new Float32Array(settings));
    const author = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); resources.push(author);
    const format = production ? "rgba8unorm" : "rgba32float";
    const target = device.createTexture({ size: [width, height], format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }); resources.push(target);
    const library = displayColorLibrary("webgpu").code;
    const code = production ? outputShader : library + vertex + `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(2) var<uniform> settings:DeepOutputSettings;
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f {
  return vec4f(deepDisplayColor(textureLoad(source,vec2i(p.xy),0).rgb,settings),1);}`;
    const module = device.createShaderModule({ code });
    const compilation = await module.getCompilationInfo();
    if (compilation.messages.some(m => m.type === "error")) throw Error(JSON.stringify(compilation.messages));
    const textureLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
      ...(production ? [{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" as const } }] : []),
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ] });
    const authorLayout = device.createBindGroupLayout({ entries: production ? [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }] : [] });
    const pipeline = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [textureLayout, authorLayout] }),
      vertex: { module, entryPoint: production ? "vertexMain" : "vs" },
      fragment: { module, entryPoint: production ? "fragmentMain" : "fs", targets: [{ format }] } });
    const rowBytes = Math.ceil(width * (production ? 4 : 16) / 256) * 256;
    const readback = device.createBuffer({ size: rowBytes * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); resources.push(readback);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(),
      loadOp: "clear", storeOp: "store", clearValue: [0,0,0,0] }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: textureLayout, entries: [
      { binding: 0, resource: source.createView() },
      ...(production ? [{ binding: 1, resource: device.createSampler({}) }] : []),
      { binding: 2, resource: { buffer } },
    ] }));
    if (production) pass.setBindGroup(1, device.createBindGroup({ layout: authorLayout,
      entries: [{ binding: 0, resource: { buffer: author } }] }));
    pass.draw(3); pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: rowBytes }, [width, height]);
    device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(readback.getMappedRange()), bytes = new Uint8Array(width * height * (production ? 4 : 16));
    for (let y = 0; y < height; y++) bytes.set(mapped.subarray(y * rowBytes, y * rowBytes + width * (production ? 4 : 16)), y * width * (production ? 4 : 16));
    readback.unmap();
    return Array.from(production ? bytes : new Float32Array(bytes.buffer));
  } finally {
    resources.forEach(resource => resource.destroy());
    const error = await device.popErrorScope(); if (error) throw Error(error.message);
  }
}

function glPixels(settings: readonly number[]) {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const gl = canvas.getContext("webgl2"); if (!gl || !gl.getExtension("EXT_color_buffer_float")) throw Error("WebGL2 float target unavailable");
  const objects: Array<() => void> = [];
  try {
    const shader = (kind: number, code: string) => {
      const s = gl.createShader(kind)!; objects.push(() => gl.deleteShader(s)); gl.shaderSource(s, code); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s) ?? "GLSL compile failed"); return s;
    };
    const vs = shader(gl.VERTEX_SHADER, `#version 300 es
void main(){vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));gl_Position=vec4(p[gl_VertexID],0,1);}`);
    const fs = shader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; precision highp int;
${displayColorLibrary("glsl-es-300").code}
uniform sampler2D source; uniform vec4 settings0; uniform vec4 settings1; out vec4 color;
void main(){ DeepOutputSettings s=DeepOutputSettings(settings0.x,settings0.y,settings0.z,settings0.w,
settings1.x,settings1.y,settings1.z,settings1.w);color=vec4(deepDisplayColor(texelFetch(source,ivec2(gl_FragCoord.xy),0).rgb,s),1);}`);
    const program = gl.createProgram()!; objects.push(() => gl.deleteProgram(program));
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program) ?? "GLSL link failed");
    gl.useProgram(program);
    const texture = (data: Float32Array | null) => {
      const t = gl.createTexture()!; objects.push(() => gl.deleteTexture(t)); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); return t;
    };
    const source = texture(input), target = texture(null), fb = gl.createFramebuffer()!; objects.push(() => gl.deleteFramebuffer(fb));
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error("GLSL target incomplete");
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source); gl.uniform1i(gl.getUniformLocation(program, "source"), 0);
    gl.uniform4fv(gl.getUniformLocation(program, "settings0"), settings.slice(0,4)); gl.uniform4fv(gl.getUniformLocation(program, "settings1"), settings.slice(4));
    gl.disable(gl.DITHER); gl.viewport(0,0,width,height); gl.drawArrays(gl.TRIANGLES,0,3);
    const out = new Float32Array(width * height * 4); gl.readPixels(0,0,width,height,gl.RGBA,gl.FLOAT,out);
    if (gl.getError() !== gl.NO_ERROR) throw Error("WebGL parity readback failed");
    return Array.from(out);
  } finally { objects.reverse().forEach(release => release()); gl.getExtension("WEBGL_lose_context")?.loseContext(); }
}

export async function runDisplayParity() {
  const adapter = await navigator.gpu?.requestAdapter(); if (!adapter) throw Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice(); const errors: string[] = [];
  device.addEventListener("uncapturederror", event => errors.push(event.error.message));
  try {
    const libraries = [];
    for (const settings of fixture.settings) libraries.push({ settings, webgpu: await gpuPixels(device, settings, false), webgl: glPixels(settings) });
    const output = await gpuPixels(device, fixture.settings[0]!, true);
    return { adapter: adapter.info, libraries, output, errors, identities: {
      webgpuLibrary: displayColorLibrary("webgpu").sourceHash,
      webglLibrary: displayColorLibrary("glsl-es-300").sourceHash, productionOutput: sha256Utf8(outputShader),
    } };
  } finally { device.destroy(); }
}
