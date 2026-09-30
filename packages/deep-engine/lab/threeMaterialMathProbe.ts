import * as THREE from "three";
import { installThreeMaterialMath } from "../../../apps/web/src/viewer/threeMaterialMath.js";
import { installThreeDisplayToneMapping } from "../../../apps/web/src/viewer/threeDisplayToneMapping.js";
import { PBR_BRDF_DIRECT_LIGHTING_WGSL } from "../src/lighting/brdfDirectLightingWgsl.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";

export const width = 384, height = 224;
type Frame = { name: string; pixels: number[]; directCoverage: number; drawCalls: number; triangles: number };

export function runThreeMaterialMathProbe() {
  const original = THREE.ShaderChunk.common, originalTone = THREE.ShaderChunk.tonemapping_pars_fragment;
  const renderers: THREE.WebGLRenderer[] = [], materials: THREE.Material[] = [], targets: THREE.WebGLRenderTarget[] = [];
  const scenes: [string, THREE.Scene, THREE.Light[]][] = [], errors: string[] = [];
  const geometry = new THREE.SphereGeometry(.8, 24, 16), quad = new THREE.PlaneGeometry(2, 2);
  const roughnessData = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const roughness = [12, 64, 166, 255][(x < 8 ? 0 : 1) + (y < 8 ? 0 : 2)]!;
    roughnessData.set([roughness, roughness, roughness, 255], (y * 16 + x) * 4);
  }
  const roughnessMap = new THREE.DataTexture(roughnessData, 16, 16); roughnessMap.needsUpdate = true;
  const numericCases = [0, .001, .1, .35, .6, .9, .999, 1].map((cosine, index) => ({ cosine, f0: [.04, .2, .95], f90: [.2, .7, 1][index % 3]! }));
  const camera = new THREE.PerspectiveCamera(45, width / height, .1, 100);
  const fixture = { roughnessTexels: Array.from(roughnessData), metallic: [0, .5, 1], emissive: [0, .02], physicalIor: 1.7, physicalClearcoat: .35 };
  function renderer() {
    const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true }); renderers.push(renderer);
    renderer.setSize(width, height, false); renderer.setPixelRatio(1);
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => errors.push([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join("\n"));
    return renderer;
  }
  function framebuffer(renderer: THREE.WebGLRenderer) {
    const gl = renderer.getContext(), bytes = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes); return Array.from(bytes);
  }
  function numeric(renderer: THREE.WebGLRenderer) {
    const material = new THREE.RawShaderMaterial({
      uniforms: { cosine: { value: 0 }, f0: { value: new THREE.Vector3(.04, .2, .95) }, f90: { value: 1 } },
      vertexShader: "precision highp float; attribute vec3 position; void main(){gl_Position=vec4(position,1.0);}",
      fragmentShader: `precision highp float;\n${THREE.ShaderChunk.common}\nuniform float cosine; uniform vec3 f0; uniform float f90; void main(){gl_FragColor=vec4(F_Schlick(f0,f90,cosine),F_Schlick(f0.r,f90,cosine));}`,
    }); materials.push(material);
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(quad, material));
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false }); targets.push(target);
    return numericCases.map(input => {
      material.uniforms.cosine!.value = input.cosine; material.uniforms.f90!.value = input.f90;
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      const value = new Float32Array(4); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, value);
      return { ...input, value: Array.from(value) };
    });
  }
  function capture(renderer: THREE.WebGLRenderer, patched: boolean) {
    const frames: Frame[] = [];
    for (const [kind, scene, lights] of scenes) for (const view of ["front", "oblique"]) for (const linear of [false, true]) {
      camera.position.set(view === "front" ? 0 : 3, view === "front" ? 0 : 2, 9); camera.lookAt(0, 0, 0);
      renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
      renderer.outputColorSpace = linear ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
      renderer.setRenderTarget(null); renderer.render(scene, camera);
      const pixels = framebuffer(renderer), drawCalls = renderer.info.render.calls, triangles = renderer.info.render.triangles;
      lights.forEach(light => { light.visible = false; }); renderer.render(scene, camera);
      const unlit = framebuffer(renderer); lights.forEach(light => { light.visible = true; });
      let directCoverage = 0;
      for (let lane = 0; lane < pixels.length; lane += 4) if (Math.max(Math.abs(pixels[lane]! - unlit[lane]!),
        Math.abs(pixels[lane + 1]! - unlit[lane + 1]!), Math.abs(pixels[lane + 2]! - unlit[lane + 2]!)) > 2) directCoverage++;
      frames.push({ name: `${kind} ${view} ${linear ? "Linear-sRGB" : "sRGB"}`, pixels, directCoverage, drawCalls, triangles });
    }
    const numbers = numeric(renderer), gl = renderer.getContext();
    if (patched && !(renderer.info.programs ?? []).every(program => gl.getShaderSource(program.fragmentShader)?.includes("float fresnel = deepSharedSchlickFactor( dotVH );"))) {
      throw Error("Actual lit material programs did not consume the production Fresnel factor");
    }
    if (gl.getError() !== gl.NO_ERROR) errors.push("GL error after material/numeric draws");
    return { frames, numbers };
  }
  try {
    installThreeDisplayToneMapping();
    for (const kind of ["Standard", "Physical"]) {
      const scene = new THREE.Scene(); scene.background = new THREE.Color(.01, .02, .03);
      const sun = new THREE.DirectionalLight(0xffffff, 4); sun.position.set(-4, 5, 6);
      const point = new THREE.PointLight(0xffbb77, 18); point.position.set(3, 2, 3); scene.add(sun, point);
      for (let index = 0; index < 6; index++) {
        const options = { color: new THREE.Color(.45, .18 + (index % 3) * .12, .12), roughness: .85, roughnessMap,
          metalness: fixture.metallic[index % 3]!, emissive: new THREE.Color(index < 3 ? 0 : .02, .01, 0) };
        const material = kind === "Standard" ? new THREE.MeshStandardMaterial(options)
          : new THREE.MeshPhysicalMaterial({ ...options, ior: fixture.physicalIor, specularIntensity: .6, clearcoat: fixture.physicalClearcoat, clearcoatRoughness: .25 });
        materials.push(material); const mesh = new THREE.Mesh(geometry, material); mesh.position.set((index % 3 - 1) * 2, index < 3 ? 1 : -1, 0); scene.add(mesh);
      }
      scenes.push([kind, scene, [sun, point]]);
    }
    const baseline = capture(renderer(), false);
    installThreeMaterialMath();
    if (!THREE.ShaderChunk.common.includes("// C8 paired material Fresnel factor")) throw Error("Production installer patched a different Three realm");
    const adapted = capture(renderer(), true);
    if (errors.length) throw Error(errors.join("\n"));
    return { width, height, errors, fixture, frames: baseline.frames.map(({ pixels, ...frame }, index) => ({ ...frame, baseline: pixels, adapted: adapted.frames[index]!.pixels,
      adaptedDirectCoverage: adapted.frames[index]!.directCoverage, adaptedDrawCalls: adapted.frames[index]!.drawCalls, adaptedTriangles: adapted.frames[index]!.triangles })),
      numbers: baseline.numbers.map(({ value, ...input }, index) => ({ ...input, baseline: value, adapted: adapted.numbers[index]!.value })),
      identities: { canonicalBrdf: sha256Utf8(PBR_BRDF_DIRECT_LIGHTING_WGSL), originalCommon: sha256Utf8(original), adaptedCommon: sha256Utf8(THREE.ShaderChunk.common) } };
  } finally {
    materials.forEach(material => material.dispose()); targets.forEach(target => target.dispose()); roughnessMap.dispose(); geometry.dispose(); quad.dispose();
    renderers.forEach(renderer => { renderer.dispose(); renderer.forceContextLoss(); });
    THREE.ShaderChunk.common = original; THREE.ShaderChunk.tonemapping_pars_fragment = originalTone;
  }
}
