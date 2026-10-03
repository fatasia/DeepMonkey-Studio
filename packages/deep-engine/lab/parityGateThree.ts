import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { threeDisplayOutputShader } from "../src/threeBridge/threeDisplayOutput.js";
import { configurePostProcessingAntialias } from "../../../apps/web/src/viewer/postProcessingAntialias.js";
import { installThreeMaterialMath } from "../../../apps/web/src/viewer/threeMaterialMath.js";
import { installThreeDisplayToneMapping } from "../../../apps/web/src/viewer/threeDisplayToneMapping.js";
import { DISPLAY_THREE_SHADOW_MAP_TYPE } from "../../../apps/web/src/viewer/displayContractThree.js";
import { parityProfile, type ParityScene } from "./parityGateScenes.js";

export interface ThreeParityContext { readonly renderer: THREE.WebGLRenderer; readonly errors: string[]; dispose(): void }

export function createThreeParityContext(): ThreeParityContext {
  installThreeMaterialMath(); installThreeDisplayToneMapping();
  const errors: string[] = [], { width, height } = parityProfile;
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(width, height, false); renderer.setPixelRatio(1); renderer.setClearColor(0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMappingExposure = parityProfile.exposure;
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => errors.push([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join("\n"));
  return { renderer, errors, dispose() { renderer.dispose(); renderer.forceContextLoss(); } };
}

export function threeCamera(spec: ParityScene): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(parityProfile.verticalFovRadians * 180 / Math.PI, parityProfile.width / parityProfile.height, parityProfile.near, parityProfile.far);
  camera.position.fromArray(spec.eye); camera.lookAt(...spec.target); camera.updateMatrixWorld(true); return camera;
}

function environmentTexture(renderer: THREE.WebGLRenderer, image: NonNullable<ParityScene["environment"]>): { texture: THREE.Texture; dispose(): void } {
  // Deep 的 equirectangular() 第 0 行 = 天顶；three 的 v 轴自下而上，所以行序翻转后喂同一份数据。
  const rgba = new Float32Array(image.width * image.height * 4);
  for (let row = 0; row < image.height; row++) for (let column = 0; column < image.width; column++) {
    const from = (row * image.width + column) * 3, to = ((image.height - 1 - row) * image.width + column) * 4;
    rgba.set([image.data[from]!, image.data[from + 1]!, image.data[from + 2]!, 1], to);
  }
  const source = new THREE.DataTexture(rgba, image.width, image.height, THREE.RGBAFormat, THREE.FloatType);
  source.mapping = THREE.EquirectangularReflectionMapping; source.colorSpace = THREE.NoColorSpace; source.magFilter = THREE.LinearFilter;
  source.minFilter = THREE.LinearFilter; source.generateMipmaps = false; source.needsUpdate = true;
  const generator = new THREE.PMREMGenerator(renderer), target = generator.fromEquirectangular(source);
  generator.dispose(); source.dispose();
  return { texture: target.texture, dispose() { target.dispose(); } };
}

export interface ThreeFrame { readonly display: number[]; readonly hdr?: number[]; readonly drawCalls: number; readonly triangles: number; readonly msaaSamples?: number }

function readDisplay(gl: WebGLRenderingContext | WebGL2RenderingContext): number[] {
  const { width, height } = parityProfile, bytes = new Uint8Array(width * height * 4), display = new Uint8Array(bytes.length);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  for (let y = 0; y < height; y++) display.set(bytes.subarray(y * width * 4, (y + 1) * width * 4), (height - 1 - y) * width * 4);
  return Array.from(display);
}

/** 线性 HDR 浮点目标读回（未色调映射）；透明混合在此目标内为线性空间混合。 */
function readHdr(renderer: THREE.WebGLRenderer, spec: ParityScene, camera: THREE.PerspectiveCamera): number[] {
  const { width, height } = parityProfile, target = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType });
  renderer.setRenderTarget(target); renderer.render(spec.scene, camera);
  const floats = new Float32Array(width * height * 4); renderer.readRenderTargetPixels(target, 0, 0, width, height, floats);
  const hdr = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let lane = 0; lane < 3; lane++) hdr[(y * width + x) * 3 + lane] = floats[((height - 1 - y) * width + x) * 4 + lane]!;
  renderer.setRenderTarget(null); target.dispose(); return Array.from(hdr);
}

/**
 * 产品 three 作者路径同款链（postProcessingRuntime.ts）：`new EffectComposer(renderer)` → RenderPass（线性 HDR 半浮点目标）→
 * [UnrealBloom] → [SMAAPass] → OutputPass（补丁后的 ACES+sRGB 输出着色器）。`antialias:true` 同时启用产品的 MSAA 目标
 * （configurePostProcessingAntialias，与产品同一函数）与 SMAA；`false` 两者都关，用来隔离混合/泛光语义。
 */
async function postFrame(context: ThreeParityContext, spec: ParityScene, camera: THREE.PerspectiveCamera, hdr: number[] | undefined): Promise<ThreeFrame> {
  const { renderer } = context, { width, height } = parityProfile, bloom = spec.post!.bloom;
  const composer = new EffectComposer(renderer);
  const msaaSamples = spec.post!.antialias ? configurePostProcessingAntialias(renderer, [composer.renderTarget1, composer.renderTarget2]) : 0;
  composer.setPixelRatio(1); composer.setSize(width, height);
  const smaa = spec.post!.antialias ? new SMAAPass() : undefined;
  composer.addPass(new RenderPass(spec.scene, camera));
  if (bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), bloom.strength, bloom.radius, bloom.threshold));
  if (smaa) composer.addPass(smaa);
  const output = new OutputPass(); output.material.fragmentShader = threeDisplayOutputShader(output.material.fragmentShader);
  composer.addPass(output);
  // SMAA 查找表以 data URL 图像异步解码；未就绪时权重纹理为空会静默退化为无 AA。
  await new Promise(resolve => setTimeout(resolve, 400));
  renderer.info.reset(); composer.render();
  const frame = { display: readDisplay(renderer.getContext()), ...(hdr ? { hdr } : {}), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, msaaSamples };
  composer.dispose(); smaa?.dispose(); output.dispose(); return frame;
}

/** 非 post 场景：renderer 直出（逐片元色调映射，无透明混合差异的不透明场景与产品 composer 路径等价）。 */
export async function renderThreeFrame(context: ThreeParityContext, spec: ParityScene): Promise<ThreeFrame> {
  const { renderer } = context, camera = threeCamera(spec);
  renderer.shadowMap.enabled = spec.shadows; renderer.shadowMap.type = DISPLAY_THREE_SHADOW_MAP_TYPE; renderer.shadowMap.needsUpdate = true;
  const environment = spec.environment ? environmentTexture(renderer, spec.environment) : undefined;
  spec.scene.environment = environment?.texture ?? null; spec.scene.environmentIntensity = 1;
  try {
    const hdr = spec.post?.bloom ? undefined : readHdr(renderer, spec, camera);
    if (spec.post) return await postFrame(context, spec, camera, hdr);
    renderer.info.reset(); renderer.render(spec.scene, camera);
    return { display: readDisplay(renderer.getContext()), hdr: hdr!, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  } finally { environment?.dispose(); spec.scene.environment = null; }
}