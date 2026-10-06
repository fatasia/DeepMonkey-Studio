import * as THREE from "three";
import { DeepWebGpuBackend, ThreeProjectionBridge, threeRenderView } from "@bim-studio/deep-engine/three-bridge";
import type { BenchmarkWorkload, RenderBenchmarkRuntime } from "./contracts";
import { fixtureCameraDistance, fixtureObjects, FIXTURE_COLORS, FIXTURE_KINDS, type FixtureKind } from "./fixture";
import { FrameSampler, ValueSampler } from "./frameSampler";

/** Deep WebGPU 档位:场景构造与 threeWebglRuntime 逐行同源(同一 fixture 原语),
 * 差异只有渲染后端——three 场景经 ThreeProjectionBridge 投影进 DeepWebGpuBackend。
 * 几何/材质/机位 parity 由构造保证,不做任何 Deep 专属调参。 */
export async function createDeepWebgpuRuntime(canvas: HTMLCanvasElement, objectCount: number, startedAt: number, workload: BenchmarkWorkload): Promise<RenderBenchmarkRuntime> {
  if (!("gpu" in navigator) || !navigator.gpu) {
    throw new Error("WebGPU 不可用:deep-webgpu 档位不回退 WebGL,保持口径诚实");
  }
  const projection = new ThreeProjectionBridge({ hooks: {
    objectBeforeRender: THREE.Object3D.prototype.onBeforeRender, objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow, objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender, materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
  } });

  const scene = new THREE.Scene();
  // 背景不设 scene.background——投影桥不支持且 Deep 经 RenderView.background 接收(见 buildView);
  // 灯光对象同样不进投影根(桥不支持 three 灯),经 projectThreeWorldLights 转 view.lights
  const renderRoot = new THREE.Group();
  const camera = createCamera(objectCount);
  const deviceRoot = new THREE.Group();
  renderRoot.add(deviceRoot);
  const geometries = new Map<FixtureKind, THREE.BufferGeometry>(FIXTURE_KINDS.map((kind) => [kind, createGeometry(kind)]));
  const materials = new Map<string, THREE.MeshStandardMaterial>(
    FIXTURE_COLORS.map((color) => [color, new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.05 })]),
  );
  const ground = createGround(objectCount);
  renderRoot.add(ground);
  addLights(scene);
  scene.add(renderRoot);

  const sampler = new FrameSampler();
  const gpuSampler = new ValueSampler();
  // 灯阵手工构造(与 threeWebglRuntime.addLights 语义一一对应):桥的通用 three 灯转换器
  // 不收 HemisphereLight 且要求 authored shadow 配置;fixture 灯固定,直构更诚实。
  const lights = {
    hemisphere: [{ directionWorld: [0, 1, 0], skyColor: [0xbd / 255, 0xdc / 255, 0xff / 255], groundColor: [0x3b / 255, 0x42 / 255, 0x49 / 255], intensity: 0.35 }],
    directional: [{ directionWorld: [-18 / 35.38, -28 / 35.38, -12 / 35.38], color: [1, 1, 1], intensity: 2.2, castShadow: true }],
  } as const;
  const view = () => buildView(camera, objectCount, lights);

  let lastRebuildMs = 0;
  let firstFrameMs = 0;
  let lastDrawCalls = 0;
  let lastTriangles = 0;
  let syncInFlight = false;
  rebuild(0);
  const initializedMs = performance.now() - startedAt;

  const backend = await DeepWebGpuBackend.create({
    canvas, gpu: navigator.gpu, projection, root: renderRoot, view: view(),
    renderer: { gpuPassTiming: true }, // F1 逐 pass GPU 计时:gpuPassTimings.milliseconds = GPU 全帧跨度(ms)
  });

  let frameOrdinal = 0;

  const tick = (now: number) => {
    sampler.record(now);
    frameOrdinal += 1;
    updateDynamicObjects(deviceRoot, now, workload);
    if (workload === "dynamic" && !syncInFlight) {
      // 产品同款在途限制:同帧最多一个场景同步,渲染消费最近已提交状态
      syncInFlight = true;
      renderRoot.updateMatrixWorld(true);
      void backend.sync(renderRoot).catch(() => {}).finally(() => { syncInFlight = false; });
    }
    const metrics = backend.render(view());
    // gpuPassTimings 滞后 1-2 帧,取最近完成读回的全帧跨度入样即可
    const gpuMs = metrics?.gpuPassTimings?.milliseconds;
    if (typeof gpuMs === "number" && Number.isFinite(gpuMs) && gpuMs > 0) gpuSampler.record(gpuMs);
    const draws = metrics?.visibleDraws;
    if (draws) { lastDrawCalls = draws.drawCalls; lastTriangles = draws.triangles; }
    if (firstFrameMs === 0) firstFrameMs = performance.now() - startedAt;
    frameId = requestAnimationFrame(tick);
  };
  let frameId = requestAnimationFrame(tick);

  const resize = () => { /* RenderView 每帧从 innerWidth/innerHeight 重建,无需额外处理 */ };
  addEventListener("resize", resize);

  function rebuild(cycle: number): void {
    const started = performance.now();
    deviceRoot.clear();
    for (const item of fixtureObjects(objectCount, cycle)) {
      const mesh = new THREE.Mesh(geometries.get(item.kind)!, materials.get(item.color)!);
      mesh.position.set(item.position[0], groundOffset(item.kind), item.position[2]);
      mesh.rotation.y = item.rotationY;
      mesh.scale.set(...item.scale);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      deviceRoot.add(mesh);
    }
    lastRebuildMs = performance.now() - started;
  }

  return {
    async rebuild(cycle) {
      rebuild(cycle);
      scene.updateMatrixWorld(true);
      const result = await backend.sync(renderRoot);
      if (result.status === "rejected") throw new Error(`Deep 场景同步被拒:${result.issues.map((issue) => `${issue.path}:${issue.feature}`).join("; ")}`);
    },
    snapshot() {
      return {
        engine: "deep-webgpu",
        workload,
        objectCount,
        initializedMs,
        firstFrameMs,
        lastRebuildMs,
        frames: sampler.snapshot(),
        ...(gpuSampler.snapshot().samples > 0 ? { gpuFrames: gpuSampler.snapshot() } : {}),
        drawCalls: lastDrawCalls,
        triangles: logicalTriangleCount(deviceRoot, ground),
      };
    },
    dispose() {
      cancelAnimationFrame(frameId);
      removeEventListener("resize", resize);
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      ground.geometry.dispose();
      ground.material.dispose();
      backend.dispose();
    },
  };
}

function buildView(camera: THREE.PerspectiveCamera, count: number, lights: NonNullable<Parameters<typeof threeRenderView>[0]["lights"]>) {
  camera.updateMatrixWorld(true); // threeRenderView 直接读 matrixWorld,无 three 渲染器代跑
  return threeRenderView({
    camera,
    target: [0, 1.8, 0],
    width: innerWidth,
    height: innerHeight,
    pixelRatio: 1,
    extent: fixtureCameraDistance(count) * 3,
    background: [0x11 / 255, 0x19 / 255, 0x1d / 255],
    floor: [0, 0, 0],
    exposure: 1.05, // 显示合约 ACES 曝光,与 threeWebglRuntime.toneMappingExposure 同值
    roughness: 0.94,
    lights,
  });
}

function updateDynamicObjects(root: THREE.Group, time: number, workload: BenchmarkWorkload): void {
  if (workload !== "dynamic") return;
  const movingCount = Math.min(200, root.children.length);
  for (let index = 0; index < movingCount; index += 1) {
    const object = root.children[index]!;
    object.rotation.y += 0.004 + index % 5 * 0.0004;
    object.position.y = groundOffset(FIXTURE_KINDS[index % FIXTURE_KINDS.length]!) + Math.sin(time * 0.0015 + index) * 0.08;
  }
}

function createCamera(count: number): THREE.PerspectiveCamera {
  const distance = fixtureCameraDistance(count);
  const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 5000);
  camera.position.set(distance, distance * 0.72, distance);
  camera.lookAt(0, 1.8, 0);
  camera.updateMatrixWorld(true); // threeRenderView 直接读 matrixWorld,无 three 渲染器代跑
  return camera;
}

function createGround(count: number): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> {
  const size = fixtureCameraDistance(count) * 3;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ color: "#202a2e", roughness: 0.94, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  return ground;
}

function addLights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xbddcff, 0x3b4249, 0.35));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(18, 28, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 140;
  scene.add(sun, sun.target);
}

function createGeometry(kind: FixtureKind): THREE.BufferGeometry {
  if (kind === "sphere") return new THREE.SphereGeometry(1, 32, 20);
  if (kind === "cylinder") return new THREE.CylinderGeometry(1, 1, 2, 32);
  if (kind === "cone") return new THREE.ConeGeometry(1, 2, 32);
  if (kind === "torus") return new THREE.TorusGeometry(1, 0.32, 18, 48);
  if (kind === "capsule") return new THREE.CapsuleGeometry(0.65, 1.4, 8, 16);
  return new THREE.BoxGeometry(2, 2, 2);
}

function groundOffset(kind: FixtureKind): number { return kind === "torus" ? 0.35 : kind === "capsule" ? 1.35 : 1; }

function logicalTriangleCount(root: THREE.Group, ground: THREE.Mesh): number {
  const devices = root.children.reduce((total, object) => {
    const geometry = (object as THREE.Mesh).geometry;
    return total + (geometry?.index?.count ?? geometry?.attributes.position?.count ?? 0) / 3;
  }, 0);
  return devices + (ground.geometry.index?.count ?? ground.geometry.attributes.position?.count ?? 0) / 3;
}
