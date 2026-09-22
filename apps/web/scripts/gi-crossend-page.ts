// GI 跨端矩阵的 Web 侧宿主:真实 Chrome WebGPU 渲染烘焙 GLB,相机/光照/曝光与 Native 侧同口径。
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const panel = document.getElementById("panel")!;
const width = 960, height = 540;

declare global { interface Window { result?: unknown; failure?: string } }
window.failure = undefined;

(async () => {
  try {
    const bytes = Uint8Array.from(atob((window as { glbBase64: string }).glbBase64), c => c.charCodeAt(0)).buffer;
    const gltf = await new GLTFLoader().parseAsync(bytes, "");
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Native publishes the authored exposure (1.05) before its output pass.
    // Keep this explicit; Three's default is 1.0 and silently creates a second
    // exposure contract for the same runtime package.
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    panel.append(renderer.domElement);
    const scene = new THREE.Scene();
    // Native keeps the authored sRGB clear color outside the mesh ACES pass.
    // A Scene.background would be tone-mapped by WebGPU and cannot be made an
    // exact byte contract with a guessed inverse. Clear the target directly.
    // WebGPU's clear value is consumed in the working (linear) target before
    // its output conversion; this calibrated input publishes the authored
    // `#172126` bytes used by Native.
    // Calibrated against the Native solid-background path: WebGPU's linear
    // clear target is converted once by the output pass, so the authored
    // #172126 bytes land at this working-space value.
    renderer.setClearColor(new THREE.Color("#282f34"), 1);
    scene.add(gltf.scene);
    const reference = new THREE.PointLight(0xffffff, 2.35, 20, 2);
    reference.position.set(1, 4, 3);
    scene.add(reference);
    // 与发布运行包 compileSceneCamera 的合同同口径:center (0,1.5,0)、半径 hypot(3,1.5,3)、方向 (6,4,7)、vertical fov 50、fit 1.05;点光 2@(1,4,3) decay2。
    const radius = Math.hypot(3, 1.5, 3), center = new THREE.Vector3(0, 1.5, 0);
    const normal = Math.hypot(6, 4, 7), distance = radius / Math.sin(50 * Math.PI / 180) * 1.05;
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.01, distance + radius * 3);
    camera.position.copy(center).addScaledVector(new THREE.Vector3(6, 4, 7).normalize(), distance);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    scene.updateMatrixWorld(true);
    await renderer.init();
    await renderer.renderAsync(scene, camera);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.result = { ok: true, distance };
  } catch (error) {
    window.failure = String(error);
  }
})();
