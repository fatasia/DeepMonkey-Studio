/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { ggxVisibilityLibrary } from "../src/shader/ggxVisibilityGlsl.js";
import { threeGgxVisibilityShader } from "../src/threeBridge/threeGgxVisibilityShader.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";
import { runThreeMaterialMathProbe } from "./threeMaterialMathProbe.js";

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("GGX GPU operation timed out")), 30000); })]); }
  finally { clearTimeout(timer); }
}

export async function runThreeGgxVisibilityProbe() {
  const originalPhysical = THREE.ShaderChunk.lights_physical_pars_fragment;
  let checkedPrograms = 0;
  const lit = runThreeMaterialMathProbe(({ patched, fragments }) => {
    if (!patched) return;
    const actualLit = fragments.filter(source => source.includes("float V_GGX_SmithCorrelated("));
    if (actualLit.length < 2 || actualLit.some(source => !source.includes("return deepSharedGgxVisibility( a2, dotNV, dotNL );"))) {
      throw Error("Actual lit programs did not consume shared Smith visibility");
    }
    checkedPrograms = actualLit.length;
  });
  if (THREE.ShaderChunk.lights_physical_pars_fragment !== originalPhysical) throw Error("Reusable production material probe failed to restore its physical chunk");
  const library = ggxVisibilityLibrary(), adaptedPhysical = threeGgxVisibilityShader(originalPhysical);
  const definition = /^float V_GGX_SmithCorrelated\([^]*?^\}/m;
  const originalFunction = originalPhysical.match(definition)![0].replace("V_GGX_SmithCorrelated(", "originalVisibility(");
  const adaptedFunction = adaptedPhysical.match(definition)![0];
  const inputs = [0.045, .2, .8, 1].flatMap(roughness => [0, 1e-7, .3, 1].flatMap(nv => [0, 1e-7, .3, 1].map(nl => {
    const alpha = Math.fround(roughness * roughness);
    return { roughness, alpha, a2: Math.fround(alpha * alpha), nv: Math.fround(nv), nl: Math.fround(nl) };
  })));
  const renderer = new THREE.WebGLRenderer({ antialias: false }), geometry = new THREE.PlaneGeometry(2, 2);
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
  const material = new THREE.RawShaderMaterial({ uniforms: { alpha: { value: 0 }, nv: { value: 0 }, nl: { value: 0 } },
    vertexShader: "precision highp float;attribute vec3 position;void main(){gl_Position=vec4(position,1.0);}",
    fragmentShader: `precision highp float;\n#define EPSILON 1e-6\nfloat pow2(float x){return x*x;}\n${originalFunction}\n${library.glsl}\n${adaptedFunction}\nuniform float alpha;uniform float nv;uniform float nl;void main(){gl_FragColor=vec4(originalVisibility(alpha,nl,nv),V_GGX_SmithCorrelated(alpha,nl,nv),0.0,1.0);}` });
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(geometry, material));
  const errors: string[] = [];
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => errors.push([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join("\n"));
  let device: GPUDevice | undefined, inputBuffer: GPUBuffer | undefined, outputBuffer: GPUBuffer | undefined, readBuffer: GPUBuffer | undefined;
  let scopes = 0;
  try {
    const glValues = inputs.map(input => {
      material.uniforms.alpha!.value = input.alpha; material.uniforms.nv!.value = input.nv; material.uniforms.nl!.value = input.nl;
      renderer.setRenderTarget(target); renderer.render(scene, new THREE.Camera());
      const value = new Float32Array(4); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, value); return Array.from(value.slice(0, 2));
    });
    const gl = renderer.getContext(); if (gl.getError() !== gl.NO_ERROR || errors.length) throw Error(`GLSL Smith GPU failure: ${errors.join("\n")}`);
    const adapter = await bounded(navigator.gpu.requestAdapter({ powerPreference: "high-performance", forceFallbackAdapter: false }));
    if (!adapter || adapter.info.isFallbackAdapter) throw Error("A non-fallback WebGPU adapter is required");
    device = await bounded(adapter.requestDevice()); device.addEventListener("uncapturederror", event => errors.push(event.error.message));
    for (const filter of ["validation", "out-of-memory", "internal"] as const) { device.pushErrorScope(filter); scopes++; }
    const packed = new Float32Array(inputs.flatMap(input => [input.a2, input.nv, input.nl, 0]));
    inputBuffer = device.createBuffer({ size: packed.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(inputBuffer, 0, packed);
    outputBuffer = device.createBuffer({ size: inputs.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    readBuffer = device.createBuffer({ size: inputs.length * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const module = device.createShaderModule({ code: `${library.wgsl}\n@group(0) @binding(0) var<storage,read> inputs:array<vec4f>;\n@group(0) @binding(1) var<storage,read_write> result:array<f32>;\n@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){if(id.x<${inputs.length}u){let v=inputs[id.x];result[id.x]=deepSharedGgxVisibility(v.x,v.y,v.z);}}` });
    const diagnostics = await bounded(module.getCompilationInfo()); if (diagnostics.messages.some(message => message.type === "error")) throw Error("WGSL Smith GPU compilation failed");
    const pipeline = await bounded(device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } }));
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: inputBuffer } }, { binding: 1, resource: { buffer: outputBuffer } }] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, inputs.length * 4); device.queue.submit([encoder.finish()]);
    await bounded(readBuffer.mapAsync(GPUMapMode.READ)); const wgsl = Array.from(new Float32Array(readBuffer.getMappedRange())); readBuffer.unmap();
    while (scopes > 0) { scopes--; const error = await device.popErrorScope(); if (error) errors.push(error.message); }
    if (errors.length) throw Error(errors.join("\n"));
    return { width: lit.width, height: lit.height, fixture: lit.fixture, frames: lit.frames, checkedPrograms, errors,
      numbers: inputs.map((input, index) => ({ ...input, original: glValues[index]![0]!, glsl: glValues[index]![1]!, wgsl: wgsl[index]! })),
      identities: { sourceBlock: library.sourceHash, originalPhysical: sha256Utf8(originalPhysical), adaptedPhysical: sha256Utf8(adaptedPhysical), lit: lit.identities } };
  } finally {
    while (scopes > 0 && device) { scopes--; await device.popErrorScope().catch(() => undefined); }
    readBuffer?.destroy(); outputBuffer?.destroy(); inputBuffer?.destroy(); device?.destroy();
    material.dispose(); geometry.dispose(); target.dispose(); renderer.dispose(); renderer.forceContextLoss();
  }
}
