import * as THREE from "three";
import type { BenchmarkWorkload, RenderBenchmarkRuntime } from "./contracts";
import { fixtureCameraDistance, fixtureObjects, FIXTURE_COLORS, FIXTURE_KINDS, type FixtureKind } from "./fixture";
import { FrameSampler } from "./frameSampler";
import { WebGlGpuTimer } from "./webGlGpuTimer";

export function createThreeWebglRuntime(canvas: HTMLCanvasElement, objectCount: number, startedAt: number, workload: BenchmarkWorkload): RenderBenchmarkRuntime {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#11191d");
  const camera = createCamera(objectCount);
  const deviceRoot = new THREE.Group();
  scene.add(deviceRoot);
  const geometries = new Map(FIXTURE_KINDS.map((kind) => [kind, createGeometry(kind)]));
  const materials = new Map<string, THREE.MeshStandardMaterial>(
    FIXTURE_COLORS.map((color) => [color, new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.05 })]),
  );
  const ground = createGround(objectCount);
  scene.add(ground);
  addLights(scene);

  const sampler = new FrameSampler();
  const context = renderer.getContext();
  const gpuTimer = context instanceof WebGL2RenderingContext ? new WebGlGpuTimer(context) : undefined;
  let lastRebuildMs = 0;
  let firstFrameMs = 0;
  rebuild(0);
  const initializedMs = performance.now() - startedAt;
  renderer.setAnimationLoop((time) => {
    sampler.record(time);
    updateDynamicObjects(deviceRoot, time, workload);
    gpuTimer?.begin();
    renderer.render(scene, camera);
    gpuTimer?.end();
    if (firstFrameMs === 0) firstFrameMs = performance.now() - startedAt;
  });

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
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
    async rebuild(cycle) { rebuild(cycle); },
    snapshot() {
      return {
        engine: "three-webgl",
        workload,
        objectCount,
        initializedMs,
        firstFrameMs,
        lastRebuildMs,
        frames: sampler.snapshot(),
        // exactOptionalPropertyTypes:GPU timer 缺席时整个属性缺席,而不是显式 undefined
        ...(gpuTimer ? { gpuFrames: gpuTimer.snapshot() } : {}),
        drawCalls: renderer.info.render.calls,
        triangles: logicalTriangleCount(deviceRoot, ground),
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
      };
    },
    dispose() {
      renderer.setAnimationLoop(null);
      removeEventListener("resize", resize);
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      ground.geometry.dispose();
      ground.material.dispose();
      gpuTimer?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
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
