/**
 * 全引擎 wasm 入口胶水(deep-engine-wasm W2)。
 *
 * 职责:
 *   1. 加载 /dev/pkg/deep_engine_wasm.js 并初始化;
 *   2. 通过唯一的适配层(adaptEngine)把"当前 pkg 的导出形态"归一成稳定接口;
 *   3. fetch 真实场景包字节(runtime-package.json)并注入引擎;
 *   4. 启动渲染(全引擎:winit 自驱事件循环;bench Viewer:JS 驱动 rAF);
 *   5. 错误面板:Rust Err / panic / 未捕获异常全部落面板供调试。
 *
 * 适配纪律:主线程正在集成的全引擎入口(假设签名 set_scene_package(bytes) +
 * start_scene_viewer())与现有 bench Viewer(new Viewer(canvas) + render_frame)
 * 之间的全部差异,只允许出现在 adaptEngine() 一个函数里;页面与其余胶水代码
 * 只认 normalize 后的 EngineSurface。签名落定后只改这一处。
 *
 * URL 参数:
 *   ?canvas=page|engine   canvas 交接模式(page=页面传入,engine=引擎自建),默认 page
 *   ?autostart=1          加载后自动启动
 *   ?pkg=<url>            覆盖场景包 URL
 *
 * 对外探针:window.__engineGlue = { state, surface, errors[], package, fps }
 * (与 wasm-bench.html 的 window.__benchResult 同风格,供采集脚本读取。)
 */

const WASM_MODULE_URL = "/dev/pkg/deep_engine_wasm.js";

/** 场景包候选来源,按序尝试;全部失败则提供文件选择回退。 */
const PACKAGE_URL_CANDIDATES = [
  // vite dev server 的 /@fs/ 端点:server.fs.allow 默认覆盖 pnpm workspace 根,
  // 因此可以从页面直接取到仓库内 test-output 的真实场景包(已实测 200)。
  "/@fs/D:/Documents/bim/bim-studio/test-output/author-grading-evidence-20260923/off/runtime-package.json",
  // 若将来某服务器以仓库根为文档根,该相对路径即可用。
  "/test-output/author-grading-evidence-20260923/off/runtime-package.json",
];

// ---------------------------------------------------------------------------
// 错误面板
// ---------------------------------------------------------------------------

class ErrorPanel {
  constructor(box) {
    this.box = box;
    this.errors = [];
    this.maxEntries = 50;
  }

  /** 来源标签 + 任意抛出值。Rust Err 经 wasm-bindgen 变成 JsValue(字符串或 Error)。 */
  report(source, thrown) {
    const message = describeThrown(thrown);
    const last = this.errors[this.errors.length - 1];
    if (last && last.message === message && last.source === source) {
      last.count++;
      last.time = timestamp();
    } else {
      this.errors.push({ time: timestamp(), source, message, count: 1 });
    }
    if (this.errors.length > this.maxEntries) this.errors.splice(0, this.errors.length - this.maxEntries);
    this.render();
  }

  render() {
    if (!this.box) return;
    if (!this.errors.length) {
      this.box.hidden = true;
      this.box.textContent = "";
      return;
    }
    this.box.hidden = false;
    this.box.textContent = this.errors
      .map((e) => `[${e.time}] ${e.source}${e.count > 1 ? ` ×${e.count}` : ""}\n${e.message}`)
      .join("\n\n");
    this.box.scrollTop = this.box.scrollHeight;
  }

  clear() {
    this.errors = [];
    this.render();
  }
}

function describeThrown(thrown) {
  if (thrown === undefined) return "undefined";
  if (thrown === null) return "null";
  if (typeof thrown === "string") return thrown; // wasm-bindgen 的 Rust Err 常直接是字符串 JsValue
  if (thrown instanceof Error) return thrown.stack || `${thrown.name}: ${thrown.message}`;
  try {
    return JSON.stringify(thrown, null, 2) ?? String(thrown);
  } catch {
    return String(thrown);
  }
}

function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 挂全局兜底:onerror / unhandledrejection / console.error。返回解除函数。 */
function captureGlobalErrors(panel) {
  const onError = (ev) => panel.report("window.onerror", ev.error ?? ev.message);
  const onRejection = (ev) => panel.report("unhandledrejection", ev.reason);
  const origConsoleError = console.error.bind(console);
  console.error = (...args) => {
    // console_error_panic_hook(Rust panic)走这条路;吞掉会丢 panic 现场,照常透传。
    panel.report("console.error", args.length === 1 ? args[0] : args.map(describeThrown).join(" "));
    origConsoleError(...args);
  };
  addEventListener("error", onError);
  addEventListener("unhandledrejection", onRejection);
  return () => {
    removeEventListener("error", onError);
    removeEventListener("unhandledrejection", onRejection);
    console.error = origConsoleError;
  };
}

// ---------------------------------------------------------------------------
// 入口签名适配层 —— 入口签名变化时只改这里
// ---------------------------------------------------------------------------

/**
 * 探测模块导出并归一为 EngineSurface:
 *
 *   kind            "full-engine"                     "bench-viewer"
 *   setScenePackage async (Uint8Array) => void         不支持(内置 bench 场景)
 *   startViewer     async (canvas|null) => Handle      async (canvas) => Handle
 *   stopViewer      (Handle) => void                   (Handle) => void
 *   engineCanvas    (Handle) => HTMLCanvasElement|null (Handle) => 入参 canvas
 *   sceneInjectable true                              false
 *
 * 全引擎 Handle 是模块句柄;bench Handle 是 Viewer 实例(含 free())。
 */
function adaptEngine(mod) {
  // 目标形态(主线程集成中,按 snake_case 与 camelCase 两种命名都探测):
  const fullSnake =
    typeof mod.set_scene_package === "function" && typeof mod.start_scene_viewer === "function";
  const fullCamel =
    typeof mod.setScenePackage === "function" && typeof mod.startSceneViewer === "function";

  if (fullSnake || fullCamel) {
    const setScenePackage = fullSnake
      ? (bytes) => mod.set_scene_package(bytes)
      : (bytes) => mod.setScenePackage(bytes);
    const startViewer = fullSnake
      ? (canvas) => mod.start_scene_viewer(canvas ?? undefined)
      : (canvas) => mod.startSceneViewer(canvas ?? undefined);
    const stopViewer = (handle) => {
      // 停止入口按"有则调"处理,避免签名演进期硬失败。
      const stop = mod.stop_scene_viewer ?? mod.stopSceneViewer;
      if (typeof stop === "function") stop(handle);
    };
    const engineCanvas = (handle) => {
      const probe = mod.engine_canvas ?? mod.engineCanvas ?? mod.viewer_canvas;
      if (typeof probe === "function") return probe(handle) ?? null;
      return null;
    };
    return { kind: "full-engine", sceneInjectable: true, setScenePackage, startViewer, stopViewer, engineCanvas };
  }

  if (typeof mod.Viewer === "function") {
    // 当前 /dev/pkg 内的 bench 首片:场景不可注入,JS 驱动渲染循环。
    return {
      kind: "bench-viewer",
      sceneInjectable: false,
      setScenePackage: async () => {
        throw new Error("bench-viewer 构建不支持场景包注入(内置 bench 场景);全引擎入口未就绪。");
      },
      startViewer: async (canvas) => new mod.Viewer(canvas),
      stopViewer: (viewer) => viewer?.free?.(),
      engineCanvas: (_handle, fallback) => fallback,
    };
  }

  throw new Error(
    `未识别的 wasm 导出形态:${Object.keys(mod).filter((k) => !k.startsWith("__")).join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// wasm 模块加载
// ---------------------------------------------------------------------------

async function loadEngineModule(panel) {
  const mod = await import(WASM_MODULE_URL);
  const init = mod.default;
  if (typeof init !== "function") throw new Error("wasm 胶水缺少 default() 初始化导出");
  await init(); // 默认按 import.meta.url 解析同目录 .wasm
  return mod;
}

// ---------------------------------------------------------------------------
// 场景包获取(fetch 真实字节 + 双口径哈希校验)
// ---------------------------------------------------------------------------

async function fetchScenePackage(candidates, panel) {
  const failures = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = new Uint8Array(await res.arrayBuffer());
      return { bytes: buffer, url };
    } catch (err) {
      failures.push(`${url} → ${describeThrown(err)}`);
    }
  }
  throw new Error(`场景包全部来源失败:\n${failures.join("\n")}`);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * packageHash 复刻(口径来源 packages/deep-engine/src/runtimePackage/hash.ts):
 * canonical v1 = 域前缀 + 键按 Unicode 标量序 + 数字编为 binary64 大端小写十六进制,
 * 对"去掉 packageHash 字段的文档"计算。文件原始字节的 sha256 与它必然不同
 * (传输完整性检查是另一口径,两者都报告,不混写)。
 */
const RUNTIME_CANONICAL_DOMAIN = "deep-engine.runtime-package.canonical.v1\n";

function runtimeCanonical(value) {
  if (typeof value === "number") {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value === 0 ? 0 : value, false); // -0 归一为 0
    return `n${view.getUint32(0).toString(16).padStart(8, "0")}${view.getUint32(4).toString(16).padStart(8, "0")}`;
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(runtimeCanonical).join(",")}]`;
  const keys = Object.keys(value).sort((a, b) => {
    const ca = [...a];
    const cb = [...b];
    for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
      const d = ca[i].codePointAt(0) - cb[i].codePointAt(0);
      if (d !== 0) return d;
    }
    return ca.length - cb.length;
  });
  return `{${keys.map((k) => `${JSON.stringify(k)}:${runtimeCanonical(value[k])}`).join(",")}}`;
}

async function verifyPackageHash(doc, bytes) {
  const verdicts = { content: null, transport: null };
  if (crypto?.subtle) {
    if (doc.packageHash?.value) {
      const { packageHash: _ignored, ...core } = doc;
      const actual = await sha256Hex(
        new TextEncoder().encode(RUNTIME_CANONICAL_DOMAIN + runtimeCanonical(core)),
      );
      verdicts.content = { actual, matches: actual === doc.packageHash.value };
    }
    verdicts.transport = await sha256Hex(bytes);
  }
  return verdicts;
}

// ---------------------------------------------------------------------------
// 渲染启动:两条路径
// ---------------------------------------------------------------------------

/**
 * 全引擎路径:winit 在 wasm 内自持事件循环(spawn_app + ControlFlow),
 * 胶水不再驱动 rAF,只负责交接 canvas 并观察生命周期。
 */
async function runFullEngine(surface, canvasMode, hostCanvas, packageBytes, status) {
  status.set(`注入场景包(${packageBytes.length} 字节)…`);
  await surface.setScenePackage(packageBytes);
  status.set(canvasMode === "engine" ? "启动引擎(引擎自建 canvas)…" : "启动引擎(页面 canvas)…");
  const handle = await surface.startViewer(canvasMode === "engine" ? null : hostCanvas);
  status.set("运行中(full-engine,winit 自驱)");
  return { handle };
}

/**
 * bench Viewer 回退路径:JS 驱动 rAF;DPR 感知,尺寸变化时把物理像素同步给
 * render_frame(其内部按 canvas.width/height 重建深度缓冲)。
 */
async function runBenchViewer(surface, hostCanvas, status, onFrame) {
  const viewer = await surface.startViewer(hostCanvas);
  status.set("运行中(bench-viewer 回退路径;场景包注入不支持)");
  let frames = 0;
  let t0 = performance.now();
  let lastReport = t0;
  let running = true;

  const fit = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(hostCanvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(hostCanvas.clientHeight * dpr));
    if (hostCanvas.width !== w || hostCanvas.height !== h) {
      hostCanvas.width = w;
      hostCanvas.height = h;
    }
  };

  const loop = (now) => {
    if (!running) return;
    fit();
    viewer.render_frame(hostCanvas.width, hostCanvas.height, (now - t0) / 1000);
    frames++;
    if (now - lastReport >= 500) {
      onFrame(frames / ((now - lastReport) / 1000));
      frames = 0;
      lastReport = now;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  return {
    handle: viewer,
    stop: () => {
      running = false;
    },
  };
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export async function bootEngine(ui) {
  const { statusEl, errBox, host, modeButton } = ui;
  const panel = new ErrorPanel(errBox);
  const releaseErrorCapture = captureGlobalErrors(panel);

  const state = {
    surface: null,
    errors: panel.errors,
    package: null,
    fps: null,
    running: false,
    canvasMode: ui.canvasMode,
  };
  globalThis.__engineGlue = state;

  const status = {
    set(text) {
      statusEl.textContent = text;
      state.statusText = text;
    },
  };

  let active = null; // { surface, handle, stop? }

  const stopActive = () => {
    if (!active) return;
    try {
      active.stop?.();
      active.surface.stopViewer(active.handle);
    } catch (err) {
      panel.report("stop", err);
    }
    active = null;
    state.running = false;
    state.fps = null;
    status.set("已停止");
  };

  const start = async () => {
    stopActive();
    panel.clear();
    try {
      if (!navigator.gpu) {
        throw new Error("navigator.gpu 不可用:本页 wasm 引擎走 WebGPU 后端,需要 WebGPU 浏览器(Chrome/Edge 113+);Firefox 需开 dom.webgpu.enabled。");
      }

      status.set("加载 wasm 模块…");
      const mod = await loadEngineModule(panel);
      const surface = adaptEngine(mod); // 签名适配集中点
      state.surface = { kind: surface.kind, sceneInjectable: surface.sceneInjectable };
      status.set(`wasm 就绪(surface=${surface.kind})`);

      // 场景包:fetch 真实字节 + SHA-256 校验;不可注入时跳过并明示。
      const pkgParam = new URLSearchParams(location.search).get("pkg");
      const candidates = pkgParam ? [pkgParam, ...PACKAGE_URL_CANDIDATES] : PACKAGE_URL_CANDIDATES;
      let pack = null;
      try {
        pack = await fetchScenePackage(candidates, panel);
        const parse = JSON.parse(new TextDecoder().decode(pack.bytes));
        const verdicts = await verifyPackageHash(parse, pack.bytes);
        state.package = {
          url: pack.url,
          bytes: pack.bytes.length,
          packageId: parse.packageId,
          schema: `${parse.schema}@v${parse.schemaVersion}`,
          hashCanonical: verdicts.content ? { matches: verdicts.content.matches } : null,
          transportSha256: verdicts.transport,
        };
        if (verdicts.content && !verdicts.content.matches) {
          panel.report(
            "package-hash",
            `packageHash(canonical v1)不匹配:期望 ${parse.packageHash.value} 实际 ${verdicts.content.actual}`,
          );
        }
        const hashNote = verdicts.content
          ? `packageHash ${verdicts.content.matches ? "通过" : "不匹配"}`
          : "packageHash 未校验";
        status.set(`场景包就绪(${pack.bytes.length} 字节,${parse.packageId},${hashNote})`);
      } catch (err) {
        panel.report("scene-package", err);
        if (surface.sceneInjectable) {
          status.set("场景包获取失败;请用下方文件选择注入,或检查 dev server。");
          return;
        }
      }

      const canvasMode = ui.canvasMode;
      let pageCanvas = host.querySelector("canvas");
      // bench-viewer 的构造签名必需 canvas,"引擎自建"是 full-engine(winit)专属能力;
      // 该回退路径下强制页面 canvas,状态里注明,而不是让 wasm 抛空指针。
      const effectiveMode = surface.kind === "full-engine" ? canvasMode : "page";
      if (effectiveMode === "page") {
        if (!pageCanvas) {
          pageCanvas = document.createElement("canvas");
          host.replaceChildren(pageCanvas);
        }
        pageCanvas.style.display = "block";
      } else {
        // 引擎自建:winit 默认 with_canvas(None) 时 document.createElement("canvas"),
        // 但不自动入 DOM(with_append(false));引擎侧需 with_append(true) 或经
        // WindowExtWebSys::canvas() 交回。宿主清空,启动后轮询认领。
        host.replaceChildren();
      }

      if (surface.kind === "full-engine") {
        if (!surface.sceneInjectable || !state.package) {
          throw new Error("full-engine 需要场景包字节;当前不可用。");
        }
        const session = await runFullEngine(surface, effectiveMode, pageCanvas, pack.bytes, status);
        active = { surface, handle: session.handle };
        if (effectiveMode === "engine") pollEngineCanvas(surface, session.handle, host, status, state);
      } else {
        const session = await runBenchViewer(surface, pageCanvas, status, (fps) => {
          state.fps = fps;
        });
        active = { surface, handle: session.handle, stop: session.stop };
        if (canvasMode !== effectiveMode) {
          status.set(`运行中(bench-viewer 回退;canvas 模式 ${canvasMode} 不适用,已用 page)`);
        }
      }
      state.running = true;
    } catch (err) {
      panel.report("boot", err);
      status.set("启动失败(见错误面板)");
    }
  };

  modeButton.addEventListener("click", () => {
    const next = ui.canvasMode === "page" ? "engine" : "page";
    const url = new URL(location.href);
    url.searchParams.set("canvas", next);
    location.href = url.href;
  });

  ui.startButton.addEventListener("click", start);
  ui.stopButton.addEventListener("click", stopActive);
  ui.fileInput?.addEventListener("change", async () => {
    const file = ui.fileInput.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    panel.clear();
    try {
      if (!active || active.surface.kind !== "full-engine") {
        throw new Error("当前 surface 不是 full-engine,无法注入场景包。");
      }
      await active.surface.setScenePackage(bytes);
      status.set(`已注入本地文件场景包(${bytes.length} 字节)`);
    } catch (err) {
      panel.report("inject-file", err);
    }
  });

  addEventListener("beforeunload", () => {
    releaseErrorCapture();
    stopActive();
  });

  state.start = start;
  state.stop = stopActive;
  state.panel = panel;
  return state;
}

/** 引擎自建 canvas 模式:轮询引擎导出/宿主 DOM,认领到后报告尺寸。 */
function pollEngineCanvas(surface, handle, host, status, state) {
  const deadline = performance.now() + 10_000;
  const tick = () => {
    const canvas = surface.engineCanvas(handle) ?? host.querySelector("canvas");
    if (canvas) {
      state.engineCanvas = canvas;
      status.set(`运行中(full-engine,引擎 canvas ${canvas.width}×${canvas.height})`);
      return;
    }
    if (performance.now() > deadline) {
      status.set("运行中(full-engine);未在 10s 内认领到引擎 canvas(检查引擎是否 with_append(true) 或导出 engine_canvas)。");
      return;
    }
    setTimeout(tick, 250);
  };
  tick();
}
