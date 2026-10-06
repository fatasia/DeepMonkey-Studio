import { Color3, Color4, DirectionalLight, EngineInstrumentation, FreeCamera, HemisphericLight, Mesh, MeshBuilder, PBRMaterial, Scene, SceneInstrumentation, ShadowGenerator, Vector3, VertexData, WebGPUEngine } from "@babylonjs/core";
import type { BenchmarkWorkload, RenderBenchmarkRuntime } from "./contracts";
import { fixtureCameraDistance, fixtureObjects, FIXTURE_COLORS, FIXTURE_KINDS, type FixtureKind } from "./fixture";
import { FrameSampler, ValueSampler } from "./frameSampler";

/** 与 threeWebglRuntime 同一 fixture 合约:确定性布局、PBR 参数、相机机位、重建与动态负载全部照抄,
 * 差异只允许来自引擎本身。三角面逐 kind 与 three 对齐(门禁几何一致性守卫容差 1%),
 * 灯光强度单位各引擎原生语义,不作跨引擎画质判定(isolation-signal-only)。 */
export async function createBabylonWebgpuRuntime(canvas: HTMLCanvasElement, objectCount: number, startedAt: number, workload: BenchmarkWorkload): Promise<RenderBenchmarkRuntime> {
  if (!(await WebGPUEngine.IsSupportedAsync)) {
    throw new Error("WebGPU 不可用:babylon-webgpu 档位不回退 WebGL,保持口径诚实");
  }
  const engine = new WebGPUEngine(canvas, { antialias: true, enableAllFeatures: true });
  await engine.initAsync();
  engine.setHardwareScalingLevel(1);

  const scene = new Scene(engine);
  scene.clearColor = Color4.FromHexString("#11191dff");
  const camera = createCamera(objectCount, scene);
  const deviceRoot = new Array<Mesh>(objectCount);
  const ground = createGround(objectCount, scene);
  ground.receiveShadows = true;
  const sun = addLights(scene);

  const materials = new Map<string, PBRMaterial>(FIXTURE_COLORS.map((color) => {
    const material = new PBRMaterial(`mat-${color}`, scene);
    material.albedoColor = Color3.FromHexString(color);
    material.metallic = 0.05;
    material.roughness = 0.72;
    return [color, material];
  }));
  const shadows = new ShadowGenerator(1024, sun);
  shadows.usePercentageCloserFiltering = true;

  // 模板只持有几何(每 kind 一份),重建时 clone 共享几何——与 three 的共享 BufferGeometry 同语义
  const templates = new Map<FixtureKind, Mesh>(FIXTURE_KINDS.map((kind) => {
    const mesh = createTemplateMesh(kind, scene);
    mesh.isVisible = false;
    return [kind, mesh];
  }));

  const sampler = new FrameSampler();
  const gpuSampler = new ValueSampler();
  const instrumentation = new SceneInstrumentation(scene);
  const engineInstrumentation = new EngineInstrumentation(engine);
  engineInstrumentation.captureGPUFrameTime = true; // timestamp-query,需 enableAllFeatures 请求该 feature
  // 引擎帧收尾(而非场景渲染后)读取,时间戳查询结果此刻才落计数器;
  // Babylon 时间戳为纳秒,除以 1e6 对齐 FrameMetrics 的毫秒口径(three 侧 GPU timer 为 ms)
  engine.onEndFrameObservable.add(() => gpuSampler.record(engineInstrumentation.gpuFrameTimeCounter.current / 1e6));

  let lastRebuildMs = 0;
  let firstFrameMs = 0;
  rebuild(0);
  const initializedMs = performance.now() - startedAt;
  engine.runRenderLoop(() => {
    const now = performance.now();
    sampler.record(now);
    updateDynamicObjects(now, workload);
    scene.render();
    if (firstFrameMs === 0) firstFrameMs = now - startedAt;
  });

  const resize = () => engine.resize();
  addEventListener("resize", resize);

  function rebuild(cycle: number): void {
    const started = performance.now();
    for (const mesh of deviceRoot) mesh?.dispose();
    fixtureObjects(objectCount, cycle).forEach((item, index) => {
      const mesh = templates.get(item.kind)!.clone(`fixture-${index}`);
      mesh.isVisible = true;
      mesh.material = materials.get(item.color)!;
      mesh.position.set(item.position[0], groundOffset(item.kind), item.position[2]);
      mesh.rotation.y = item.rotationY;
      mesh.scaling.set(item.scale[0], item.scale[1], item.scale[2]);
      shadows.addShadowCaster(mesh, false);
      deviceRoot[index] = mesh;
    });
    lastRebuildMs = performance.now() - started;
  }

  function updateDynamicObjects(time: number, active: BenchmarkWorkload): void {
    if (active !== "dynamic") return;
    const movingCount = Math.min(200, deviceRoot.length);
    for (let index = 0; index < movingCount; index += 1) {
      const mesh = deviceRoot[index]!;
      mesh.rotation.y += 0.004 + index % 5 * 0.0004;
      mesh.position.y = groundOffset(kindAt(index)) + Math.sin(time * 0.0015 + index) * 0.08;
    }
  }

  function kindAt(index: number): FixtureKind { return FIXTURE_KINDS[index % FIXTURE_KINDS.length]!; }

  /** 逻辑三角形与 threeWebglRuntime 同口径:几何声明值求和,不含引擎侧剔除。 */
  function logicalTriangleCount(): number {
    const deviceTotal = deviceRoot.reduce((total, mesh) => total + (mesh.geometry?.getTotalIndices() ?? 0) / 3, 0);
    return deviceTotal + (ground.geometry?.getTotalIndices() ?? 0) / 3;
  }

  return {
    async rebuild(cycle) { rebuild(cycle); },
    snapshot() {
      return {
        engine: "babylon-webgpu",
        workload,
        objectCount,
        initializedMs,
        firstFrameMs,
        lastRebuildMs,
        frames: sampler.snapshot(),
        gpuFrames: gpuSampler.snapshot(),
        drawCalls: instrumentation.drawCallsCounter.current,
        triangles: logicalTriangleCount(),
      };
    },
    dispose() {
      engine.stopRenderLoop();
      removeEventListener("resize", resize);
      engineInstrumentation.dispose();
      instrumentation.dispose();
      materials.forEach((material) => material.dispose());
      scene.dispose();
      engine.dispose();
    },
  };
}

function createCamera(count: number, scene: Scene): FreeCamera {
  const distance = fixtureCameraDistance(count);
  const camera = new FreeCamera("benchmark", new Vector3(distance, distance * 0.72, distance), scene);
  camera.fov = 48 * Math.PI / 180; // threeWebglRuntime 同机位:48° 纵向 FOV
  camera.minZ = 0.1;
  camera.maxZ = 5000;
  camera.setTarget(new Vector3(0, 1.8, 0));
  return camera;
}

function createGround(count: number, scene: Scene): Mesh {
  const size = fixtureCameraDistance(count) * 3;
  const ground = MeshBuilder.CreateGround("ground", { width: size, height: size }, scene);
  const material = new PBRMaterial("ground", scene);
  material.albedoColor = Color3.FromHexString("#202a2e");
  material.metallic = 0;
  material.roughness = 0.94;
  ground.material = material;
  return ground;
}

function addLights(scene: Scene): DirectionalLight {
  const hemispheric = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemispheric.diffuse = Color3.FromHexString("#bddcff");
  hemispheric.groundColor = Color3.FromHexString("#3b4249");
  hemispheric.intensity = 0.35;
  const sun = new DirectionalLight("sun", new Vector3(-18, -28, -12), scene);
  sun.position = new Vector3(18, 28, 12); // 与 three 光源同点,阴影视锥原点一致
  sun.intensity = 2.2;
  sun.shadowMinZ = 0.1;
  sun.shadowMaxZ = 140;
  return sun;
}

function createTemplateMesh(kind: FixtureKind, scene: Scene): Mesh {
  // 球/环手写 VertexData 对齐 three 拓扑(1216/1728 三角面);MeshBuilder 自带拓扑无法精确匹配
  if (kind === "sphere") {
    const mesh = new Mesh(kind, scene);
    sphereVertexData(32, 20).applyToMesh(mesh);
    return mesh;
  }
  if (kind === "torus") {
    const mesh = new Mesh(kind, scene);
    torusVertexData(1, 0.32, 18, 48).applyToMesh(mesh);
    return mesh;
  }
  // 尺寸与细分对齐 threeWebglRuntime.createGeometry:cylinder 128 / cone 64 / capsule 544 / box 12 三角面
  if (kind === "cylinder") return MeshBuilder.CreateCylinder(kind, { height: 2, diameter: 2, tessellation: 32 }, scene);
  if (kind === "cone") return MeshBuilder.CreateCylinder(kind, { height: 2, diameterTop: 0, diameterBottom: 2, tessellation: 16 }, scene);
  if (kind === "capsule") return MeshBuilder.CreateCapsule(kind, { radius: 0.65, height: 2.7, tessellation: 8, capSubdivisions: 16 }, scene);
  return MeshBuilder.CreateBox(kind, { size: 2 }, scene);
}

/** 标准 UV 球,widthSeg×heightSeg 与 three SphereGeometry(1,32,20) 同拓扑:1216 三角面。 */
function sphereVertexData(widthSegments: number, heightSegments: number): VertexData {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const grid: number[][] = [];
  for (let y = 0; y <= heightSegments; y += 1) {
    const row: number[] = [];
    const v = y / heightSegments;
    for (let x = 0; x <= widthSegments; x += 1) {
      const u = x / widthSegments;
      const px = -Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI);
      const py = Math.cos(v * Math.PI);
      const pz = Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI);
      positions.push(px, py, pz);
      normals.push(px, py, pz);
      row.push(positions.length / 3 - 1);
    }
    grid.push(row);
  }
  for (let y = 0; y < heightSegments; y += 1) {
    for (let x = 0; x < widthSegments; x += 1) {
      const a = grid[y]![x + 1]!;
      const b = grid[y]![x]!;
      const c = grid[y + 1]![x]!;
      const d = grid[y + 1]![x + 1]!;
      if (y !== 0) indices.push(a, b, d);
      if (y !== heightSegments - 1) indices.push(b, c, d);
    }
  }
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.normals = normals;
  vertexData.indices = indices;
  return vertexData;
}

/** 环面与 three TorusGeometry(1,0.32,18,48) 同拓扑:1728 三角面,环面平铺在 XZ 平面。 */
function torusVertexData(radius: number, tube: number, radialSegments: number, tubularSegments: number): VertexData {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= radialSegments; j += 1) {
    const u = j / radialSegments * Math.PI * 2;
    const center = { x: radius * Math.cos(u), z: radius * Math.sin(u) };
    for (let i = 0; i <= tubularSegments; i += 1) {
      const v = i / tubularSegments * Math.PI * 2;
      const cosV = Math.cos(v);
      const sinV = Math.sin(v);
      positions.push(
        (radius + tube * cosV) * Math.cos(u),
        tube * sinV,
        (radius + tube * cosV) * Math.sin(u),
      );
      normals.push(cosV * Math.cos(u), sinV, cosV * Math.sin(u));
    }
  }
  const stride = tubularSegments + 1;
  for (let j = 1; j <= radialSegments; j += 1) {
    for (let i = 1; i <= tubularSegments; i += 1) {
      const a = stride * (j - 1) + (i - 1) + 1;
      const b = stride * (j - 1) + i + 1;
      const c = stride * j + i + 1;
      const d = stride * j + (i - 1) + 1;
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.normals = normals;
  vertexData.indices = indices;
  return vertexData;
}

function groundOffset(kind: FixtureKind): number { return kind === "torus" ? 0.35 : kind === "capsule" ? 1.35 : 1; }
