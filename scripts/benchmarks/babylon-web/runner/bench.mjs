import * as Babylon from "@babylonjs/core/index.js";

// V4 性能基准 Babylon Web 轨道基准页（浏览器侧）。
// 夹具对齐 bevy-0.19 轨道 factory-instances/cubes-v2（scripts/benchmarks/bevy-0.19.1/src/main.rs）：
//   - 256 个 0.08 立方体实例（1 几何 + 1 材质，12 三角形/个 = 3072）
//   - 网格布局 x=(i%side)*0.11-offset, y=((i*17)%7)*0.007, z=(i/side)*0.11-offset, offset=(side-1)*0.055
//   - 材质 base srgb(0.24,0.52,0.9)、metallic 0.15、roughness 0.42（sRGB→线性由本侧显式换算）
//   - 平行光方向 normalize(0.2855,0.8,0.586)、开启阴影（Babylon 1024 shadow map，口径差异见 README）
//   - 相机 yaw 0.55、distance 4、fov=2*atan(1/2.05)、near 0.1、far 100、看向原点
//   - 视口 1280x720、MSAA 4（WebGPU antialias；WebGL2 回退时由浏览器决定）
// 采集语义（诚实声明）：
//   - cpu 帧时 = 同步 scene.render() 墙钟（循环驱动，无 rAF/vsync 钳制；对应 bevy auto-no-vsync 语义）
//   - gpu 帧时 = Babylon WebGPU timestamp-query（captureGPUFrameTime，原始纳秒），引擎不支持则如实为空
//   - 画面取证由 Node 侧 CDP 截图完成（页内 toDataURL/GL readPixels 在不保留绘图缓冲时拿到的是空帧，不可信）

const srgbToLinear = (value) => (value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));

export async function runBabylonWebBench(config) {
  const { instances = 256, warmupFrames = 30, sampleFrames = 120,
    width = 1280, height = 720, cameraYaw = 0.55, cameraDistance = 4, cameraFocal = 2.05,
    lightIntensity = 3.0 } = config ?? {};

  const canvas = document.querySelector("#bench-canvas");
  canvas.width = width;
  canvas.height = height;

  // 后端选择：WebGPU 优先（对应 bevy Vulkan 档位），不支持时回退 WebGL2 并如实记录原因。
  const probe = { webgpuSupported: false, adapter: null, probeError: null, unavailableReason: null };
  try {
    // 注意：IsSupportedAsync 是 static getter，返回 Promise<boolean>——不能加括号调用
    probe.webgpuSupported = await (Babylon.WebGPUEngine.IsSupportedAsync);
  } catch (error) { probe.probeError = String(error); }
  if (!probe.webgpuSupported) {
    try {
      if (!navigator.gpu) probe.unavailableReason = "navigator.gpu missing";
      else {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) probe.unavailableReason = "requestAdapter returned null";
        else {
          const device = await adapter.requestDevice();
          probe.unavailableReason = "adapter+device ok but Babylon IsSupportedAsync rejected (headless capability gate)";
          device.destroy?.();
        }
      }
    } catch (error) { probe.unavailableReason = `probe failed: ${String(error).slice(0, 200)}`; }
  }
  if (probe.webgpuSupported) {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (adapter) probe.adapter = adapter.info ? { ...adapter.info } : null;
    } catch (error) { probe.adapterError = String(error); }
  }

  let engine;
  let backend;
  if (probe.webgpuSupported) {
    engine = await Babylon.WebGPUEngine.CreateAsync(canvas, { antialias: true });
    backend = "webgpu";
  } else {
    engine = new Babylon.Engine(canvas, true, { stencil: false, preserveDrawingBuffer: true }, true);
    backend = "webgl2";
  }
  const glInfo = typeof engine.getGlInfo === "function" ? engine.getGlInfo() : null;
  const tEngineReady = performance.now();
  // headless 实测：KHR_parallel_shader_compile 的完成回调不返回 → 材质 isReady 永远 false → 静默跳绘。
  // 禁用并行编译，让 Babylon 同步编译着色器（证据字段见 observations.materialReady*）。
  try { engine.disableParallelShaderCompile = true; } catch { /* 老引擎无此开关 */ }

  const scene = new Babylon.Scene(engine);
  scene.clearColor = new Babylon.Color4(0.02, 0.02, 0.03, 1);

  const camera = new Babylon.FreeCamera("camera",
    new Babylon.Vector3(-cameraDistance * Math.sin(cameraYaw), 0, cameraDistance * Math.cos(cameraYaw)),
    scene);
  camera.setTarget(Babylon.Vector3.Zero()); // 对齐 bevy Transform.looking_at(Vec3::ZERO)（FreeCamera 默认朝 +Z，不设 target 会背对场景）
  camera.fov = 2 * Math.atan(1 / cameraFocal);
  camera.minZ = 0.1;
  camera.maxZ = 100;
  scene.activeCamera = camera;

  const lightDirection = new Babylon.Vector3(0.2855, 0.8, 0.586).normalizeFromLength(1);
  const light = new Babylon.DirectionalLight("dir-light", lightDirection, scene);
  light.intensity = lightIntensity; // 口径差异：bevy illuminance=18000 lux，Babylon 为无量纲倍率
  light.position = lightDirection.scale(-6);

  const material = new Babylon.PBRMaterial("cube-material", scene);
  material.albedoColor = new Babylon.Color3(srgbToLinear(0.24), srgbToLinear(0.52), srgbToLinear(0.9));
  material.metallic = 0.15;
  material.roughness = 0.42;
  try {
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.tonemapMode = Babylon.ImageProcessingConfiguration.TONEMAPPING_ACES ?? 1;
  } catch { /* 保持默认成像，差异在报告中记录 */ }

  const cube = Babylon.MeshBuilder.CreateBox("cube", { size: 0.08 }, scene);
  cube.material = material;
  cube.receiveShadows = true;
  const side = Math.ceil(Math.sqrt(instances));
  const offset = (side - 1) * 0.055;
  const matrices = new Float32Array(instances * 16);
  for (let index = 0; index < instances; index += 1) {
    const x = (index % side) * 0.11 - offset;
    const z = Math.floor(index / side) * 0.11 - offset;
    const y = ((index * 17) % 7) * 0.007;
    matrices.set(Babylon.Matrix.Translation(x, y, z).m, index * 16);
  }
  cube.thinInstanceSetBuffer("matrix", matrices, 16, { staticBuffer: true });

  let shadowEnabled = false;
  let shadowError = null;
  try {
    const shadows = new Babylon.ShadowGenerator(1024, light); // 口径差异：bevy 默认 shadow map 尺寸不同
    shadows.usePercentageCloserFiltering = true;
    shadows.addShadowCaster(cube);
    shadowEnabled = true;
  } catch (error) { shadowError = String(error); }

  let gpuTimestamps = false;
  let gpuTimestampError = null;
  try {
    if (typeof engine.captureGPUFrameTime === "function") {
      engine.captureGPUFrameTime(true);
      gpuTimestamps = engine._timestampQuery?._enabled === true;
      if (!gpuTimestamps) gpuTimestampError = "engine rejected timestamp query (timerQuery capability missing)";
    } else {
      gpuTimestampError = "captureGPUFrameTime unavailable on this engine";
    }
  } catch (error) { gpuTimestampError = String(error); }

  // 就绪等待（对齐 bevy synchronous_pipeline_compilation 语义）：着色器/管线异步编译完成后再
  // 采首帧与样本；headless 下管线编译完成较慢，直接渲染会静默跳绘（isReady=false 不画）。
  const tWaitStart = performance.now();
  await Promise.race([
    scene.whenReadyAsync(),
    new Promise((resolve) => setTimeout(resolve, 30_000)), // 30s 就绪超时，超时后如实记录未就绪
  ]);
  const tSceneReady = performance.now();
  const sceneReadyFlag = scene.isReady(false);

  scene.render(); // 第一帧：管线已就绪
  const tFirstFrame = performance.now();
  const materialReadyAfterFirstRender = material.isReady(cube);
  const sceneReadyAfterFirstRender = scene.isReady(false);

  for (let frame = 0; frame < warmupFrames; frame += 1) scene.render();

  const renderMs = [];
  const gpuMs = [];
  const heapSamples = [];
  for (let frame = 0; frame < sampleFrames; frame += 1) {
    const start = performance.now();
    scene.render();
    renderMs.push(performance.now() - start);
    const counter = typeof engine.getGPUFrameTimeCounter === "function" ? engine.getGPUFrameTimeCounter() : null;
    gpuMs.push(counter ? Number(counter.current) : null);
    if (frame % 10 === 0 && performance.memory) {
      heapSamples.push({ frame, usedJSHeapSize: performance.memory.usedJSHeapSize });
    }
  }
  scene.render(); // 结束帧：保证画布停留在最后一张已呈现内容上，供截图取证

  // 画面取证：克隆一台非激活相机 → CreateScreenshotAsync 走 RTT 离屏渲染 + readPixels 路径
  // （激活相机的画布 drawImage 路径在 WebGPU present 后缓冲失效会拿到空帧；RTT 读回跨后端可靠）。
  // clearColor=(5,5,8)，非背景阈差 12。PNG 落盘供人工查验。
  let snapshot = { pixels: null, pngBase64: null, error: null, method: "render-target" };
  try {
    const screenshotCamera = camera.clone("screenshot-camera");
    const rawScreenshot = await Babylon.Tools.CreateScreenshotAsync(engine, screenshotCamera, { width, height });
    const dataUrl = typeof rawScreenshot === "string" ? rawScreenshot : rawScreenshot?.data;
    if (!dataUrl) throw new Error("screenshot returned no data");
    const src = dataUrl.startsWith("data:") ? dataUrl : `data:image/png;base64,${dataUrl}`;
    snapshot.pngBase64 = src.slice(src.indexOf(",") + 1);
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("snapshot decode failed"));
      image.src = src;
    });
    const scratch = document.createElement("canvas");
    scratch.width = image.width;
    scratch.height = image.height;
    const context2d = scratch.getContext("2d", { willReadFrequently: true });
    context2d.drawImage(image, 0, 0);
    const data = context2d.getImageData(0, 0, image.width, image.height).data;
    let count = 0;
    for (let offset = 0; offset + 3 < data.length; offset += 4) {
      if (Math.abs(data[offset] - 5) > 12 || Math.abs(data[offset + 1] - 5) > 12
        || Math.abs(data[offset + 2] - 8) > 12) count += 1;
    }
    snapshot.pixels = count;
  } catch (error) {
    snapshot.error = String(error).slice(0, 200);
  }

  const report = {
    backend,
    webgpuSupported: probe.webgpuSupported,
    unavailableReason: probe.unavailableReason,
    adapter: probe.adapter,
    adapterError: probe.adapterError ?? null,
    probeError: probe.probeError,
    glInfo: glInfo ?? null,
    renderer: probe.adapter?.description ?? glInfo?.renderer ?? null,
    dpr: window.devicePixelRatio,
    canvasSize: [canvas.width, canvas.height],
    engineReady: engine.isReady,
    sceneReadyWaitMs: tSceneReady - tWaitStart,
    sceneReadyFlag,
    materialReadyAfterFirstRender,
    sceneReadyAfterFirstRender,
    materialReadyAtEnd: material.isReady(cube),
    sceneReadyAtEnd: scene.isReady(false),
    cubeVisible: cube.isVisible && cube.isEnabled(),
    cameraFront: camera.getFrontPosition(1).asArray(),
    fixture: {
      instanceCount: cube.thinInstanceCount ?? instances,
      geometryCount: 1,
      materialCount: 1,
      triangles: instances * 12,
      activeMeshCount: scene.getActiveMeshes().length,
    },
    shadowEnabled,
    shadowError,
    gpuTimestamps,
    gpuTimestampError,
    gpuRawUnit: "nanoseconds (WebGPU timestamp-query two-value subtraction, Babylon perfCounter.current)",
    renderMs,
    gpuMs,
    heapSamples,
    heapFinal: performance.memory ? performance.memory.usedJSHeapSize : null,
    pageTiming: { engineReadyMs: tEngineReady, firstFrameMs: tFirstFrame },
    pagePerfOriginWallclock: performance.timeOrigin,
    snapshot,
    engineType: engine.constructor?.name ?? null,
  };
  // 引擎不 dispose：截图取证需要画布保留最后呈现帧；页面随浏览器进程退出统一回收
  return report;
}
