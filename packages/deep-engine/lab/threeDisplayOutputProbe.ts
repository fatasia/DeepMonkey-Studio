import * as THREE from "three";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { OutputShader } from "three/examples/jsm/shaders/OutputShader.js";
import { threeDisplayOutputShader } from "../src/threeBridge/threeDisplayOutput.js";
import { displayColorLibrary } from "../src/shader/displayColorBackends.js";
import { sha256Utf8 } from "../src/shaderPackage/hash.js";

export const width = 96, height = 32;
const colors = [[0, 0, 0], [0.003, 0.003, 0.003], [0.018, 0.018, 0.018], [0.18, 0.18, 0.18],
  [0.7, 0.7, 0.7], [1, 1, 1], [2, 0.1, 0.04], [0.1, 4, 0.1], [0.04, 0.1, 8],
  [3, 2, 1], [16, 16, 16], [0.01, 0.2, 2]];
const modes: Array<[string, THREE.ToneMapping, number, THREE.ColorSpace]> = [
  ["ACES low", THREE.ACESFilmicToneMapping, 0.25, THREE.SRGBColorSpace],
  ["ACES default", THREE.ACESFilmicToneMapping, 1, THREE.SRGBColorSpace],
  ["ACES high", THREE.ACESFilmicToneMapping, 3, THREE.SRGBColorSpace],
  ["ACES linear output", THREE.ACESFilmicToneMapping, 1, THREE.LinearSRGBColorSpace],
  ["None", THREE.NoToneMapping, 2, THREE.SRGBColorSpace],
  ["Linear", THREE.LinearToneMapping, 0.5, THREE.SRGBColorSpace],
  ["Reinhard", THREE.ReinhardToneMapping, 1, THREE.SRGBColorSpace],
  ["Cineon", THREE.CineonToneMapping, 1, THREE.SRGBColorSpace],
  ["AgX", THREE.AgXToneMapping, 1, THREE.SRGBColorSpace],
  ["Neutral", THREE.NeutralToneMapping, 1, THREE.SRGBColorSpace],
];

function compileEs300(gl: WebGL2RenderingContext, code: string): void {
  const shader = gl.createShader(gl.FRAGMENT_SHADER);
  if (!shader) throw Error("fragment allocation failed");
  try {
    gl.shaderSource(shader, `#version 300 es\nprecision highp float;\n${code}\nout vec4 result;\nvoid main(){result=vec4(deepThreeAcesFit(vec3(2.0,0.2,0.01),1.0),1.0);}`);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader) ?? "ES300 compilation failed");
  } finally { gl.deleteShader(shader); }
}

export function runThreeDisplayOutputProbe() {
  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  const library = displayColorLibrary("glsl-es-300");
  const errors: string[] = [];
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    errors.push([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join("\n"));
  };
  const texture = new THREE.DataTexture(new Float32Array(width * height * 4), width, height, THREE.RGBAFormat, THREE.FloatType);
  const pixels = texture.image.data as Float32Array;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.set([...colors[Math.floor(x / 8)]!, 1], (y * width + x) * 4);
  }
  texture.needsUpdate = true;
  const readBuffer = new THREE.WebGLRenderTarget(width, height);
  readBuffer.texture = texture;
  const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType, depthBuffer: false });
  const baseline = new OutputPass(), adapted = new OutputPass();
  const render = (pass: OutputPass) => {
    pass.render(renderer, target, readBuffer, 0, false);
    const output = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, output);
    return Array.from(output);
  };
  try {
    adapted.material.fragmentShader = threeDisplayOutputShader(adapted.material.fragmentShader);
    renderer.setSize(width, height, false);
    compileEs300(renderer.getContext() as WebGL2RenderingContext, library.code);
    const frames = modes.map(([name, mapping, exposure, colorSpace]) => {
      renderer.toneMapping = mapping; renderer.toneMappingExposure = exposure; renderer.outputColorSpace = colorSpace;
      return { name, aces: mapping === THREE.ACESFilmicToneMapping, exposure, colorSpace,
        baseline: render(baseline), adapted: render(adapted) };
    });
    const glError = renderer.getContext().getError();
    if (glError !== 0) errors.push(`GL error ${glError}`);
    if (errors.length) throw Error(errors.join("\n"));
    return { width, height, frames, errors, es100: baseline.material.glslVersion === null && adapted.material.glslVersion === null,
      es300: true, identities: { original: sha256Utf8(OutputShader.fragmentShader),
        adapted: sha256Utf8(adapted.material.fragmentShader), library: library.sourceHash } };
  } finally {
    baseline.dispose(); adapted.dispose(); target.dispose(); readBuffer.dispose(); texture.dispose(); renderer.dispose(); renderer.forceContextLoss();
  }
}
