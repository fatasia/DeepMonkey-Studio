// P3-02 缩窄切片验证宿主（浏览器入口，由 scripts/verify-p03-02-preview.mts 用 esbuild 打包）。
// 编辑会话叙事：同一作者 revision 的包变体 A→B/B′（bar 数据+背景色，draft+改动+生产 canonical rehash）。
// 三场景：w1 连续换包提交（A→B）；w2 陈旧编辑取消（B 在 GPU prepare 闸门内被会话 abort，A 可见帧逐位不变，B′ 随后提交）；
// w3 坏包失败隔离（篡改字节在请求准备阶段被哈希完整性拒绝，先于任何 GPU 分配，A 保持可见，会话随后仍可提交 B）。
// Three/场景通道与真实编辑器 UI 会话不在本片；只收集证据与断言，不修改生产源码。
import { DeviceSession } from "../packages/deep-engine/src/webgpu/deviceSession.js";
import { BackendCanvasDeck, type BackendCanvasHost, type BackendCanvasSurface } from "../packages/deep-engine/src/threeBridge/BackendCanvasDeck.js";
import { createDashboardCompositionGpuHost, type DashboardVisibleGpuFrame } from "../packages/deep-engine/src/webgpu/dashboardCompositionHost.js";
import { DashboardCandidateController } from "../packages/deep-engine/src/runtimePackage/dashboardCandidateController.js";
import { chartFrame } from "../apps/web/src/delivery/dashboardChartFrame.js";

const SURFACE_WIDTH = 960, SURFACE_HEIGHT = 540, DEVICE_EPOCH = 1;
const DIFF_PIXEL_THRESHOLD = 1000;
type FixtureId = "a" | "b" | "b2" | "bad";
interface Manifest {
  fixtures: Record<FixtureId, { packageHash: string }>;
  expectations: { webFailureText: string };
}
type Pixels = Uint8ClampedArray;

interface Check { readonly name: string; readonly pass: boolean; readonly expected: unknown; readonly actual: unknown }
interface StepRec { readonly name: string; readonly ms: number; readonly detail?: Record<string, unknown> }
interface ScenarioRec { readonly id: string; ok: boolean; readonly checks: Check[]; readonly steps: StepRec[]; readonly frames: Record<string, string> }
interface P03Success {
  ok: boolean;
  adapter: Readonly<{ vendor: string; architecture: string; device: string; description: string; isFallbackAdapter: boolean }> | null;
  canvasFormat: string;
  scenarios: ScenarioRec[];
  observations: Record<string, string>;
}
interface P03Failure { ok: false; stage: string; message: string; stack?: string }
export type P03Result = P03Success | P03Failure;
declare global { interface Window { __P0302_RESULT?: P03Result } }
type Controller = DashboardCandidateController<any, any, DashboardVisibleGpuFrame>;

class C1CanvasHost implements BackendCanvasHost {
  readonly token = Symbol("p0302-deck-host");
  constructor(private readonly container: HTMLDivElement) {}
  ensureGridLayout(): void { this.container.style.display = "grid"; }
  createCanvas(): BackendCanvasSurface { return new C1Surface(document.createElement("canvas")); }
  append(surface: BackendCanvasSurface): void { this.container.appendChild(surface.native as HTMLCanvasElement); }
}
class C1Surface implements BackendCanvasSurface {
  constructor(readonly native: HTMLCanvasElement) {}
  get width(): number { return this.native.width; }
  set width(value: number) { this.native.width = value; }
  get height(): number { return this.native.height; }
  set height(value: number) { this.native.height = value; }
  get parentToken(): unknown { return null; }
  getStyle(name: string): string { return this.native.style.getPropertyValue(name); }
  setStyle(name: string, value: string): void { this.native.style.setProperty(name, value); }
  getAttribute(name: string): string | null { return this.native.getAttribute(name); }
  setAttribute(name: string, value: string): void { this.native.setAttribute(name, value); }
  removeAttribute(name: string): void { this.native.removeAttribute(name); }
  remove(): void { this.native.remove(); }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
interface Gate { readonly entered: ReturnType<typeof deferred>; readonly resume: ReturnType<typeof deferred> }
interface FrameProbe { readonly identity: { packageHash: string; generation: number }; gpuDisposeCalls(): number }
interface Stack {
  readonly session: DeviceSession;
  readonly deck: BackendCanvasDeck;
  readonly controller: Controller;
  deferPrepare(): Gate;
  disposeProbe(packageHash: string): FrameProbe | undefined;
  readonly counts: { prepares: number; commits: number; releases: number };
  teardown(): Promise<{ deviceLostResolved: boolean; deviceLostReason: string; diagnostics: readonly unknown[] }>;
}
async function openStack(gpu: GPU): Promise<Stack> {
  const sessionCanvas = document.createElement("canvas");
  sessionCanvas.width = 4; sessionCanvas.height = 4;
  sessionCanvas.style.cssText = "position:fixed;left:-10000px;top:0;";
  document.body.appendChild(sessionCanvas);
  const session = await DeviceSession.open(sessionCanvas, gpu, new AbortController().signal);
  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-10000px;top:0;width:${SURFACE_WIDTH}px;height:${SURFACE_HEIGHT}px;overflow:hidden;`;
  document.body.appendChild(container);
  const initial = new C1Surface(document.createElement("canvas"));
  initial.width = SURFACE_WIDTH; initial.height = SURFACE_HEIGHT;
  const deck = new BackendCanvasDeck(new C1CanvasHost(container), "deep-dashboard-initial", initial);
  const raw = createDashboardCompositionGpuHost({ deck, session, width: SURFACE_WIDTH, height: SURFACE_HEIGHT,
    deviceEpoch: () => DEVICE_EPOCH, chartFrame });
  const probes: FrameProbe[] = [];
  const counts = { prepares: 0, commits: 0, releases: 0 };
  const host: typeof raw.host = {
    currentDeviceEpoch: () => raw.host.currentDeviceEpoch(),
    async prepare(page, resources, signal) {
      counts.prepares += 1;
      const frame = await raw.host.prepare(page, resources, signal);
      let calls = 0;
      const original = frame.gpu.dispose.bind(frame.gpu);
      frame.gpu.dispose = () => { calls += 1; original(); };
      probes.push({ identity: page.identity, gpuDisposeCalls: () => calls });
      return frame;
    },
    commitVisible(frame) { counts.commits += 1; raw.host.commitVisible(frame); },
    release(frame) { counts.releases += 1; raw.host.release(frame); },
  };
  const controller = new DashboardCandidateController(raw.loader, host);
  return {
    session, deck, controller: controller as Controller, counts,
    deferPrepare() {
      const gate = { entered: deferred(), resume: deferred() };
      const inner = host.prepare.bind(host);
      host.prepare = async (page, resources, signal) => {
        const frame = await inner(page, resources, signal);
        gate.entered.resolve(); await gate.resume.promise; return frame;
      };
      return gate;
    },
    disposeProbe: packageHash => probes.find(probe => probe.identity.packageHash === packageHash),
    async teardown() {
      controller.dispose(); deck.dispose();
      // destroy() 触发 lost 事件；10s 兜底防实现差异悬挂，超时按未触发如实记录。
      const lost = session.device.lost.then(info => ({ reason: info.reason, message: info.message }));
      const timeout = new Promise<"timeout">(done => setTimeout(() => done("timeout"), 10_000));
      session.dispose();
      const outcome = await Promise.race([lost, timeout]);
      return { deviceLostResolved: outcome !== "timeout", deviceLostReason: outcome === "timeout" ? "timeout" : String(outcome.reason ?? "unspecified"),
        diagnostics: session.diagnostics };
    },
  };
}

/** publish 后同步读回：先合成到不透明黑底再 getImageData（premultiplied canvas 展示语义，与 Native 不透明读回同口径）。 */
function readback(deck: BackendCanvasDeck): { dataUrl: string; colored: number; pixels: Pixels } {
  const source = deck.active!.canvas.native as HTMLCanvasElement;
  const capture = document.createElement("canvas");
  capture.width = source.width; capture.height = source.height;
  const context = capture.getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = "#000";
  context.fillRect(0, 0, capture.width, capture.height);
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, capture.width, capture.height);
  let colored = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset] || image.data[offset + 1] || image.data[offset + 2]) colored += 1;
  }
  return { dataUrl: capture.toDataURL("image/png"), colored, pixels: image.data };
}
function diffPixels(a: Pixels, b: Pixels): number {
  let different = 0;
  for (let offset = 0; offset < a.length; offset += 4) {
    if (a[offset] !== b[offset] || a[offset + 1] !== b[offset + 1]
      || a[offset + 2] !== b[offset + 2] || a[offset + 3] !== b[offset + 3]) different += 1;
  }
  return different;
}
function scenario(id: string) {
  const checks: Check[] = [];
  return {
    id, checks, steps: [] as StepRec[], frames: {} as Record<string, string>, ok: false,
    equal: (name: string, expected: unknown, actual: unknown) => { checks.push({ name, pass: expected === actual, expected, actual }); },
    truthy: (name: string, pass: boolean, actual: unknown) => { checks.push({ name, pass, expected: true, actual }); },
  };
}
type Scenario = ReturnType<typeof scenario>;
async function timed(name: string, steps: StepRec[], run: () => Promise<Record<string, unknown> | void>): Promise<void> {
  const start = performance.now();
  const detail = await run() ?? {};
  steps.push({ name, ms: Math.round((performance.now() - start) * 100) / 100, detail });
}
async function waitGate(gate: Gate, pending: Promise<unknown>, label: string): Promise<void> {
  let state = "pending";
  void pending.then(value => { state = `settled:${JSON.stringify((value as { status?: string }).status ?? value)}`; },
    error => { state = `rejected:${String(error).slice(0, 200)}`; });
  const timeout = new Promise<null>(done => setTimeout(() => done(null), 20_000));
  const reached = await Promise.race([gate.entered.promise.then(() => true), timeout]) !== null;
  if (!reached) throw new Error(`${label}: defer gate 未到达（publish 未进入 host 阶段），pending=${state}`);
}
/** 收尾断言（与 P05 同口径）：device.lost 触发 + 无 uncaptured GPU error。 */
function finish(scenarios: Scenario[], teardown: { deviceLostResolved: boolean; diagnostics: readonly unknown[] }): void {
  for (const item of scenarios) {
    item.checks.push({ name: "teardown device.lost 已触发（GPU device 真实销毁）",
      pass: teardown.deviceLostResolved, expected: true, actual: teardown.deviceLostResolved },
      { name: "teardown 无 uncaptured GPU error",
        pass: !teardown.diagnostics.some(entry => (entry as { kind: string }).kind === "error"),
        expected: 0, actual: teardown.diagnostics.filter(entry => (entry as { kind: string }).kind === "error").length });
    item.ok = item.checks.every(check => check.pass);
  }
}

/** w1 连续换包：A→B 提交，断言可见帧替换、旧帧释放、GPU lease 关闭、像素可区分。 */
async function w1Successive(gpu: GPU, manifest: Manifest, load: (id: FixtureId) => Promise<unknown>): Promise<Scenario> {
  const round = scenario("w1-successive-replace");
  const { fixtures } = manifest;
  const stack = await openStack(gpu);
  try {
    let baselinePixels: Pixels | undefined, baselineColored = 0;
    await timed("publish A（作者原包）", round.steps, async () => {
      const result = await stack.controller.publish(await load("a"), { deviceEpoch: DEVICE_EPOCH });
      round.equal("A commit", "committed", result.status);
      round.equal("A hash 与驱动侧一致", fixtures.a.packageHash, result.identity?.packageHash);
      const seen = readback(stack.deck);
      round.frames["web-w1-A.png"] = seen.dataUrl;
      baselinePixels = seen.pixels; baselineColored = seen.colored;
      return { identity: result.identity, colored: baselineColored };
    });
    await timed("publish B（bar 数据+背景色，rehash）", round.steps, async () => {
      const result = await stack.controller.publish(await load("b"), { deviceEpoch: DEVICE_EPOCH });
      round.equal("B commit", "committed", result.status);
      round.truthy("B hash 独立于 A", result.identity?.packageHash === fixtures.b.packageHash
        && fixtures.b.packageHash !== fixtures.a.packageHash, result.identity?.packageHash);
      const seenB = readback(stack.deck);
      round.frames["web-w1-B.png"] = seenB.dataUrl;
      round.equal("旧帧(A) host.release 恰 1 次", 1, stack.counts.releases);
      round.equal("旧帧(A) GPU lease 真实 dispose", 1, stack.disposeProbe(fixtures.a.packageHash)?.gpuDisposeCalls() ?? -1);
      round.equal("现可见帧(B) GPU lease 未被释放", 0, stack.disposeProbe(fixtures.b.packageHash)?.gpuDisposeCalls() ?? -1);
      round.equal("deck 表面数回收（无残留表面）", 2, stack.deck.surfaceCount);
      round.truthy("A/B 像素可区分", diffPixels(baselinePixels!, seenB.pixels) > DIFF_PIXEL_THRESHOLD,
        diffPixels(baselinePixels!, seenB.pixels));
      round.truthy("B 可见帧有内容", seenB.colored > 0, seenB.colored);
      return { identity: result.identity, counts: { ...stack.counts } };
    });
  } finally {
    finish([round], await stack.teardown());
  }
  return round;
}

/** w2 陈旧编辑取消：B 的 GPU 帧已在闸门内构建完成，作者 revision 前进（B′ 到达）→ 会话令牌 abort B；
 * A 可见帧逐位不变；B′ 随后提交并替换 A。 */
async function w2StaleCancel(gpu: GPU, manifest: Manifest, load: (id: FixtureId) => Promise<unknown>): Promise<Scenario> {
  const round = scenario("w2-stale-cancel");
  const { fixtures } = manifest;
  const stack = await openStack(gpu);
  try {
    let baselinePixels: Pixels | undefined;
    await timed("publish A（基线）", round.steps, async () => {
      const result = await stack.controller.publish(await load("a"), { deviceEpoch: DEVICE_EPOCH });
      round.equal("A commit", "committed", result.status);
      const seen = readback(stack.deck);
      round.frames["web-w2-A-baseline.png"] = seen.dataUrl;
      baselinePixels = seen.pixels;
      return { identity: result.identity, colored: seen.colored };
    });
    const activeA = stack.deck.active;
    const gate = stack.deferPrepare();
    let pending: Promise<{ status?: string; releaseFailures?: readonly string[] }> | undefined;
    await timed("publish B（prepare 闸门内被 B′ 到达取消）", round.steps, async () => {
      const abort = new AbortController();
      pending = stack.controller.publish(await load("b"), { deviceEpoch: DEVICE_EPOCH, signal: abort.signal });
      await waitGate(gate, pending!, "w2 deferPrepare");
      round.truthy("B GPU 帧已构建而可见帧仍是 A 的表面", stack.deck.active === activeA,
        stack.deck.active === activeA ? "activeA" : "other");
      abort.abort(); // 作者 revision 前进：会话令牌取消在途编辑 B（B′ 到达语义）
      gate.resume.resolve();
      const result = await pending!;
      round.equal("B 状态 aborted", "aborted", result.status);
      round.equal("陈旧帧(B) host.release 恰 1 次", 1, stack.counts.releases);
      round.equal("陈旧帧(B) GPU lease 真实 dispose", 1, stack.disposeProbe(fixtures.b.packageHash)?.gpuDisposeCalls() ?? -1);
      round.equal("A 帧 GPU lease 未被释放", 0, stack.disposeProbe(fixtures.a.packageHash)?.gpuDisposeCalls() ?? -1);
      round.truthy("取消后 A 仍挂载于 deck", stack.deck.active === activeA,
        stack.deck.active === activeA ? "activeA" : "other");
      const after = readback(stack.deck);
      round.frames["web-w2-A-after-abort.png"] = after.dataUrl;
      const baselineDiff = diffPixels(baselinePixels!, after.pixels);
      round.truthy("取消后可见帧像素与 A 基线逐位一致且有内容", baselineDiff === 0 && after.colored > 0,
        { baselineDiff, colored: after.colored });
      return { status: result.status, counts: { ...stack.counts } };
    });
    await timed("publish B′（第二版编辑）", round.steps, async () => {
      const result = await stack.controller.publish(await load("b2"), { deviceEpoch: DEVICE_EPOCH });
      round.equal("B′ commit", "committed", result.status);
      round.truthy("B′ hash 独立于 A/B", result.identity?.packageHash === fixtures.b2.packageHash
        && fixtures.b2.packageHash !== fixtures.b.packageHash && fixtures.b2.packageHash !== fixtures.a.packageHash,
        result.identity?.packageHash);
      const seenB2 = readback(stack.deck);
      round.frames["web-w2-B2.png"] = seenB2.dataUrl;
      round.equal("累计 host.release 2 次（陈旧 B、A 各一）", 2, stack.counts.releases);
      round.equal("A 帧 GPU lease 在 B′ 提交后真实 dispose", 1, stack.disposeProbe(fixtures.a.packageHash)?.gpuDisposeCalls() ?? -1);
      round.equal("现可见帧(B′) GPU lease 未被释放", 0, stack.disposeProbe(fixtures.b2.packageHash)?.gpuDisposeCalls() ?? -1);
      round.equal("deck 表面数回收", 2, stack.deck.surfaceCount);
      round.truthy("A/B′ 像素可区分", diffPixels(baselinePixels!, seenB2.pixels) > DIFF_PIXEL_THRESHOLD,
        diffPixels(baselinePixels!, seenB2.pixels));
      round.truthy("B′ 可见帧有内容", seenB2.colored > 0, seenB2.colored);
      return { identity: result.identity, counts: { ...stack.counts } };
    });
  } finally {
    finish([round], await stack.teardown());
  }
  return round;
}

/** w3 坏包失败隔离：篡改字节在请求准备阶段被哈希校验拒绝（publish reject，先于任何 loader/host 分配），
 * A 保持可见逐位不变；同一会话随后提交 B，证明失败未污染会话。 */
async function w3FailureIsolation(gpu: GPU, manifest: Manifest, load: (id: FixtureId) => Promise<unknown>): Promise<Scenario> {
  const round = scenario("w3-failure-isolation");
  const { fixtures } = manifest;
  const stack = await openStack(gpu);
  try {
    let baselinePixels: Pixels | undefined;
    await timed("publish A（基线）", round.steps, async () => {
      const result = await stack.controller.publish(await load("a"), { deviceEpoch: DEVICE_EPOCH });
      round.equal("A commit", "committed", result.status);
      const seen = readback(stack.deck);
      round.frames["web-w3-A-baseline.png"] = seen.dataUrl;
      baselinePixels = seen.pixels;
      return { identity: result.identity, colored: seen.colored };
    });
    const activeA = stack.deck.active;
    await timed("publish BAD（篡改字节，未 rehash）", round.steps, async () => {
      let rejected: string | undefined;
      try { await stack.controller.publish(await load("bad"), { deviceEpoch: DEVICE_EPOCH }); }
      catch (error) { rejected = error instanceof Error ? error.message : String(error); }
      round.truthy("坏包 publish 被 reject 且消息指向哈希完整性",
        !!rejected && new RegExp(manifest.expectations.webFailureText, "i").test(rejected ?? ""), rejected ?? "no-rejection");
      round.equal("无新增 host prepare（GPU 分配未发生）", 1, stack.counts.prepares);
      round.equal("无新增可见提交", 1, stack.counts.commits);
      round.equal("无 host.release", 0, stack.counts.releases);
      round.truthy("A 仍挂载于 deck", stack.deck.active === activeA, stack.deck.active === activeA ? "activeA" : "other");
      const after = readback(stack.deck);
      round.frames["web-w3-A-after-bad.png"] = after.dataUrl;
      const baselineDiff = diffPixels(baselinePixels!, after.pixels);
      round.truthy("失败后可见帧像素与 A 基线逐位一致且有内容", baselineDiff === 0 && after.colored > 0,
        { baselineDiff, colored: after.colored });
      return { rejected: rejected?.slice(0, 200), counts: { ...stack.counts } };
    });
    await timed("publish B（坏包之后会话仍可提交）", round.steps, async () => {
      const result = await stack.controller.publish(await load("b"), { deviceEpoch: DEVICE_EPOCH });
      round.equal("B commit", "committed", result.status);
      round.equal("B hash 正确", fixtures.b.packageHash, result.identity?.packageHash);
      const seenB = readback(stack.deck);
      round.frames["web-w3-B.png"] = seenB.dataUrl;
      round.equal("A 帧 host.release 恰 1 次（B 提交时）", 1, stack.counts.releases);
      round.equal("A 帧 GPU lease 真实 dispose", 1, stack.disposeProbe(fixtures.a.packageHash)?.gpuDisposeCalls() ?? -1);
      round.equal("现可见帧(B) GPU lease 未被释放", 0, stack.disposeProbe(fixtures.b.packageHash)?.gpuDisposeCalls() ?? -1);
      round.truthy("A/B 像素可区分", diffPixels(baselinePixels!, seenB.pixels) > DIFF_PIXEL_THRESHOLD,
        diffPixels(baselinePixels!, seenB.pixels));
      round.truthy("B 可见帧有内容", seenB.colored > 0, seenB.colored);
      return { identity: result.identity, counts: { ...stack.counts } };
    });
  } finally {
    finish([round], await stack.teardown());
  }
  return round;
}

async function run(): Promise<P03Result> {
  let stage = "webgpu-probe";
  try {
    const gpu = navigator.gpu;
    if (!gpu) throw new Error("WebGPU is unavailable in this browser (navigator.gpu is undefined).");
    stage = "manifest";
    const manifest: Manifest = await (await fetch("/manifest.json")).json();
    const cache = new Map<FixtureId, unknown>();
    const load = async (id: FixtureId): Promise<unknown> => {
      if (!cache.has(id)) {
        const response = await fetch(`/fixture/${id}.json`);
        if (!response.ok) throw new Error(`fixture ${id} fetch failed: HTTP ${response.status}`);
        cache.set(id, await response.json());
      }
      return cache.get(id)!;
    };
    const scenarios: ScenarioRec[] = [];
    stage = "w1"; scenarios.push(await w1Successive(gpu, manifest, load));
    stage = "w2"; scenarios.push(await w2StaleCancel(gpu, manifest, load));
    stage = "w3"; scenarios.push(await w3FailureIsolation(gpu, manifest, load));
    stage = "adapter-info";
    const probeSession = await DeviceSession.open(Object.assign(document.createElement("canvas"),
      { width: 4, height: 4 }), gpu, new AbortController().signal);
    const adapter = probeSession.adapterInfo ?? null;
    const canvasFormat = probeSession.format;
    probeSession.dispose();
    const observations = {
      selectionContract: "合同不支持选择迁移：DashboardCandidateState/DashboardPageCandidate/identity 无选择字段；跨包提交时 pageStates.clear()（dashboardCandidateController.ts L79），chart 数据游标仅同 packageHash 内迁移（L69-70）。「相同对象 id 换包保持选中」留待 G01。",
      staleCancelContract: "DashboardCandidateController 并发 publish 返回 busy、不抢占；在途编辑取消的合同表达是会话 AbortSignal（本片 w2）或 controller.dispose（会话级，P0-05 组 b dispose 模式已覆盖，会连带回收可见 A 帧，不属「保持可见」语义）。",
      failureIsolationContract: "坏包在 prepareDashboardCandidateRequest 的 validateDeepRuntimePackage 被拒（publish promise reject，非 status=failed），先于 loader/host 任何分配；status=failed 属加载/呈现阶段失败，不在本片坏包路径。",
      threeChannel: "Three/场景通道与真实编辑器 UI 会话不在本片（宿主直驱）；真实 OS 窗口交互归后续。",
    };
    return { ok: scenarios.every(item => item.ok), adapter, canvasFormat, scenarios, observations };
  } catch (error) {
    return { ok: false, stage, message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined };
  }
}
void run().then(result => { window.__P0302_RESULT = result; });
