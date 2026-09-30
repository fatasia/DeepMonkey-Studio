import * as THREE from "three";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { threeDisplayOutputShader } from "../src/threeBridge/threeDisplayOutput.js";
import { installThreeDisplayToneMapping } from "../../../apps/web/src/viewer/threeDisplayToneMapping.js";
import { displayColorLibrary } from "../src/shader/displayColorBackends.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";

export const width = 96, height = 32;
const colors: [number, number, number][] = [[0, 0, 0], [.003, .003, .003], [.018, .018, .018], [.18, .18, .18], [.7, .7, .7],
  [1, 1, 1], [2, .1, .04], [.1, 4, .1], [.04, .1, 8], [3, 2, 1], [16, 16, 16], [.01, .2, 2]];
const settings: [string, THREE.ToneMapping, number, THREE.ColorSpace][] = [
  ["ACES low", THREE.ACESFilmicToneMapping, .25, THREE.SRGBColorSpace],
  ["ACES default", THREE.ACESFilmicToneMapping, 1, THREE.SRGBColorSpace],
  ["ACES high", THREE.ACESFilmicToneMapping, 3, THREE.SRGBColorSpace],
  ["ACES linear", THREE.ACESFilmicToneMapping, 1, THREE.LinearSRGBColorSpace],
  ["Linear", THREE.LinearToneMapping, .5, THREE.SRGBColorSpace],
  ["AgX", THREE.AgXToneMapping, 1, THREE.SRGBColorSpace],
];
type Frame = { name: string; aces: boolean; pixels: number[] };

export function runThreeDirectDisplayProbe() {
  const original = THREE.ShaderChunk.tonemapping_pars_fragment;
  const camera = new THREE.OrthographicCamera(-6, 6, 1, -1, .1, 10); camera.position.z = 2;
  const geometry = new THREE.PlaneGeometry(1, 2);
  const materials: THREE.Material[] = [], scenes: [string, THREE.Scene][] = [];
  const renderers: THREE.WebGLRenderer[] = [], passes: OutputPass[] = [], targets: THREE.WebGLRenderTarget[] = [];
  const errors: string[] = [];
  let texture: THREE.DataTexture | undefined;
  function renderer() {
    const value = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true }); renderers.push(value);
    value.setPixelRatio(1); value.setSize(width, height, false);
    value.debug.onShaderError = (gl, program, vertex, fragment) => errors.push([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join("\n"));
    return value;
  }
  const setMode = (renderer: THREE.WebGLRenderer, mode: typeof settings[number]) => {
    renderer.toneMapping = mode[1]; renderer.toneMappingExposure = mode[2]; renderer.outputColorSpace = mode[3];
  };
  try {
    for (const kind of ["Basic", "Standard", "Physical"]) {
      const scene = new THREE.Scene(); scene.background = new THREE.Color(0, 0, 0);
      for (const [index, rgb] of colors.entries()) {
        const color = new THREE.Color(rgb[0], rgb[1], rgb[2]);
        const material = kind === "Basic" ? new THREE.MeshBasicMaterial({ color })
          : kind === "Standard" ? new THREE.MeshStandardMaterial({ color: 0, emissive: color, roughness: .4, metalness: .5 })
            : new THREE.MeshPhysicalMaterial({ color: 0, emissive: color, roughness: .4, metalness: .5 });
        materials.push(material); const mesh = new THREE.Mesh(geometry, material); mesh.position.x = index - 5.5; scene.add(mesh);
      }
      scenes.push([kind, scene]);
    }
    const data = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...colors[Math.floor(x / 8)]!, 1], (y * width + x) * 4);
    texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType); texture.needsUpdate = true;
    const input = new THREE.WebGLRenderTarget(width, height); input.texture = texture; targets.push(input);
    const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false }); targets.push(target);
    function capture(renderer: THREE.WebGLRenderer, patched: boolean): Frame[] {
      const frames: Frame[] = [];
      for (const [kind, scene] of scenes) for (const mode of settings) {
        setMode(renderer, mode); renderer.setRenderTarget(null); renderer.render(scene, camera);
        // A normal render target intentionally bypasses Three tone mapping. Read
        // the actual default framebuffer to prove material direct consumption.
        const pixels = new Uint8Array(width * height * 4), gl = renderer.getContext();
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        frames.push({ name: `${kind} ${mode[0]}`, aces: mode[1] === THREE.ACESFilmicToneMapping, pixels: Array.from(pixels) });
      }
      const pass = new OutputPass(); passes.push(pass);
      if (patched) pass.material.fragmentShader = threeDisplayOutputShader(pass.material.fragmentShader);
      for (const mode of [settings[1]!, settings[4]!]) {
        setMode(renderer, mode); pass.render(renderer, target, input, 0, false);
        const pixels = new Uint8Array(width * height * 4); renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
        frames.push({ name: `S2 composed ${mode[0]}`, aces: mode[1] === THREE.ACESFilmicToneMapping, pixels: Array.from(pixels) });
      }
      const gl = renderer.getContext();
      if (patched) {
        const programs = renderer.info.programs ?? [];
        if (programs.length < 3 || !programs.every(program => gl.getShaderSource(program.fragmentShader)?.includes("return deepThreeAcesFit( color, toneMappingExposure );"))) {
          throw Error("Actual material/OutputPass programs did not compile the production shared fit");
        }
      }
      if (gl.getError() !== gl.NO_ERROR) errors.push("GL error after production draws");
      return frames;
    }
    const baseline = capture(renderer(), false);
    installThreeDisplayToneMapping();
    if (!THREE.ShaderChunk.tonemapping_pars_fragment.includes("// C8 paired direct tone mapping")) throw Error("Production installer patched a different Three realm");
    const adapted = capture(renderer(), true);
    if (errors.length) throw Error(errors.join("\n"));
    return { width, height, errors, frames: baseline.map((frame, index) => ({ name: frame.name, aces: frame.aces, baseline: frame.pixels, adapted: adapted[index]!.pixels })),
      identities: { originalChunk: sha256Utf8(original), adaptedChunk: sha256Utf8(THREE.ShaderChunk.tonemapping_pars_fragment), library: displayColorLibrary("glsl-es-300").sourceHash } };
  } finally {
    passes.forEach(pass => pass.dispose()); targets.forEach(target => target.dispose()); texture?.dispose();
    materials.forEach(material => material.dispose()); geometry.dispose();
    renderers.forEach(renderer => { renderer.dispose(); renderer.forceContextLoss(); });
    THREE.ShaderChunk.tonemapping_pars_fragment = original;
  }
}
