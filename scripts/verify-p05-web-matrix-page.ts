// P0-05 矩阵验证宿主（浏览器入口，由 scripts/verify-p05-web-matrix.mts 用 esbuild 打包）。
// 在真实 WebGPU 上按 DashboardCandidateController 合同验证三组矩阵：
// a 连续换包（不同 packageHash 的 draft+改动+rehash 变体）、b 迟到候选（defer host.prepare 后
// abort/dispose）、c 取消（AbortSignal 在 load / GPU prepare 两个窗口中止）。
// 验证宿主非产品入口；只收集证据与断言，不修改生产源码。
import { DeviceSession } from "../packages/deep-engine/src/webgpu/deviceSession.js";
import { BackendCanvasDeck, type BackendCanvasHost, type BackendCanvasSurface } from "../packages/deep-engine/src/threeBridge/BackendCanvasDeck.js";
import { createDashboardCompositionGpuHost, type DashboardVisibleGpuFrame } from "../packages/deep-engine/src/webgpu/dashboardCompositionHost.js";
import { DashboardCandidateController } from "../packages/deep-engine/src/runtimePackage/dashboardCandidateController.js";
import { runtimeContentSha256, runtimePackageSha256 } from "../packages/deep-engine/src/runtimePackage/hash.js";
import type { DashboardPageCandidate } from "../packages/deep-engine/src/runtimePackage/dashboardCandidateTypes.js";
import { chartFrame } from "../apps/web/src/delivery/dashboardChartFrame.js";

const SURFACE_WIDTH = 960, SURFACE_HEIGHT = 540, DEVICE_EPOCH = 1;
const DIFF_PIXEL_THRESHOLD = 1000;

interface Check { readonly name: string; readonly pass: boolean; readonly expected: unknown; readonly actual: unknown }
interface StepRec { readonly name: string; readonly ms: number; readonly detail?: Record<string, unknown> }
interface RoundRec { ok: boolean; readonly checks: Check[]; readonly steps: StepRec[]; readonly frames: Record<string, string> }
interface GroupRec { readonly id: string; readonly ok: boolean; readonly rounds: RoundRec[] }
interface P05Success {
  ok: boolean;
  adapter: Readonly<{ vendor: string; architecture: string; device: string; description: string; isFallbackAdapter: boolean }> | null;
  canvasFormat: string;
  groups: GroupRec[];
  observations: Record<string, unknown>;
}
interface P05Failure { ok: false; stage: string; message: string; stack?: string }
export type P05Result = P05Success | P05Failure;
declare global { interface Window { __P05_RESULT?: P05Result } }
type Controller = DashboardCandidateController<any, any, DashboardVisibleGpuFrame>;

class C1CanvasHost implements BackendCanvasHost {
  readonly token = Symbol("p05-deck-host");
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
/** draft（深拷贝）+ 内容改动（背景板填色 + 两个 chart 数据行）+ 生产 canonical hash 重算。 */
function rehashedVariant(base: unknown, tag: "B" | "A2"): Record<string, unknown> {
  const value = structuredClone(base) as Record<string, unknown>;
  const payloads = value.payloads as Record<string, any>;
  const fills = { B: [0.05, 0.52, 0.16, 0.94], A2: [0.12, 0.10, 0.55, 0.94] } as const;
  const rows = { B: [[6, 0.65], [3, 0.35]], A2: [[8, 0.5], [5, 0.15]] } as const;
  payloads["dashboard.static.a"].displayList.commands[0].fill = [...fills[tag]];
  for (const id of ["dashboard.chart.a", "dashboard.chart.b"]) {
    const dataset = payloads[id].chart.datasets[0];
    dataset.rows[0][1] = rows[tag][0]![0]; dataset.rows[0][2] = rows[tag][0]![1];
    dataset.rows[1][1] = rows[tag][1]![0]; dataset.rows[1][2] = rows[tag][1]![1];
  }
  for (const resource of value.resources as any[]) resource.contentHash.value = runtimeContentSha256(payloads[resource.id]);
  value.packageHash.value = runtimePackageSha256(value);
  return value;
}

interface FrameProbe { readonly identity: { packageHash: string; generation: number }; gpuDisposeCalls(): number }
interface Gate { readonly entered: ReturnType<typeof deferred>; readonly resume: ReturnType<typeof deferred> }
/** 每个 stack 的 device.lost 终态记录（Chrome/Dawn 对 destroy 路径的 reason 可能缺省，仅记录不判真伪）。 */
const lostRecords: { stack: number; reason: string; resolved: boolean }[] = [];
let stackCounter = 0;
interface Stack {
  readonly session: DeviceSession;
  readonly deck: BackendCanvasDeck;
  readonly controller: Controller;
  readonly probes: FrameProbe[];
  readonly counts: { prepares: number; commits: number; releases: number };
  deferPrepare(): Gate;
  deferLoad(): Gate;
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
  const loader = raw.loader;
  // host 包装：计数 prepare/commit/release，并给每个 GPU lease 装 dispose 探针（真实 destroy 观测点）。
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
  const controller = new DashboardCandidateController(loader, host);
  return {
    session, deck, controller: controller as Controller, probes, counts,
    deferPrepare() {
      const gate = { entered: deferred(), resume: deferred() };
      const inner = host.prepare.bind(host);
      host.prepare = async (page, resources, signal) => {
        const frame = await inner(page, resources, signal);
        gate.entered.resolve(); await gate.resume.promise; return frame;
      };
      return gate;
    },
    deferLoad() {
      const gate = { entered: deferred(), resume: deferred() };
      const inner = loader.load.bind(loader);
      loader.load = async (...args: Parameters<typeof loader.load>) => {
        gate.entered.resolve(); await gate.resume.promise; return inner(...args);
      };
      return gate;
    },
    async teardown() {
      controller.dispose(); deck.dispose();
      // destroy() 触发 lost 事件；10s 兜底防实现差异悬挂，超时按未触发如实记录。
      const lost = session.device.lost.then(info => ({ reason: info.reason, message: info.message }));
      const timeout = new Promise<"timeout">(done => setTimeout(() => done("timeout"), 10_000));
      session.dispose();
      const outcome = await Promise.race([lost, timeout]);
      const record = { stack: ++stackCounter,
        reason: outcome === "timeout" ? "timeout" : String(outcome.reason ?? "unspecified"),
        resolved: outcome !== "timeout" };
      lostRecords.push(record);
      return { deviceLostResolved: record.resolved, deviceLostReason: record.reason,
        diagnostics: session.diagnostics };
    },
  };
}

function readback(deck: BackendCanvasDeck) {
  const source = deck.active!.canvas.native as HTMLCanvasElement;
  const capture = document.createElement("canvas");
  capture.width = source.width; capture.height = source.height;
  const context = capture.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, capture.width, capture.height);
  let colored = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset] || image.data[offset + 1] || image.data[offset + 2]) colored += 1;
  }
  return { dataUrl: capture.toDataURL("image/png"), colored, pixels: image.data };
}
function diffPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let different = 0;
  for (let offset = 0; offset < a.length; offset += 4) {
    if (a[offset] !== b[offset] || a[offset + 1] !== b[offset + 1]
      || a[offset + 2] !== b[offset + 2] || a[offset + 3] !== b[offset + 3]) different += 1;
  }
  return different;
}
function checks() {
  const list: Check[] = [];
  const equal = (name: string, expected: unknown, actual: unknown) => {
    list.push({ name, pass: expected === actual, expected, actual });
  };
  const truthy = (name: string, pass: boolean, actual: unknown) => {
    list.push({ name, pass, expected: true, actual });
  };
  return { list, equal, truthy };
}
async function timed(name: string, steps: StepRec[], run: () => Promise<Record<string, unknown> | void>): Promise<void> {
  const start = performance.now();
  const detail = await run() ?? {};
  steps.push({ name, ms: Math.round((performance.now() - start) * 100) / 100, detail });
}
/** 等待 defer 闸门；publish 若在 prepare 前失败/返回，entered 永不 resolve，此处以探针暴露真实状态。 */
async function waitGate(gate: Gate, pending: Promise<unknown>, label: string): Promise<void> {
  let state = "pending";
  void pending.then((value) => { state = `settled:${JSON.stringify((value as { status?: string }).status ?? value)}`; },
    (error) => { state = `rejected:${String(error).slice(0, 200)}`; });
  const timeout = new Promise<null>(done => setTimeout(() => done(null), 20_000));
  const reached = await Promise.race([gate.entered.promise.then(() => true), timeout]) !== null;
  if (!reached) throw new Error(`${label}: defer gate 未到达（publish 未进入 host 阶段），pending=${state}`);
}
function finish(rounds: RoundRec[], teardown: { deviceLostResolved: boolean; deviceLostReason: string; diagnostics: readonly unknown[] }): void {
  for (const round of rounds) {
    round.checks.push({ name: "teardown device.lost 已触发（GPU device 真实销毁）",
      pass: teardown.deviceLostResolved, expected: true, actual: teardown.deviceLostResolved },
      { name: "teardown 无 uncaptured GPU error", pass: !teardown.diagnostics.some(item => (item as { kind: string }).kind === "error"),
        expected: 0, actual: teardown.diagnostics.filter(item => (item as { kind: string }).kind === "error").length });
    round.ok = round.checks.every(item => item.pass);
  }
}

/** 组 a 连续换包：A→B（轮1）、B→A2（轮2），断言可见帧替换、旧帧释放、GPU lease 关闭、像素可区分。 */
async function groupSuccessive(gpu: GPU, base: unknown): Promise<GroupRec> {
  const stack = await openStack(gpu);
  const rounds: RoundRec[] = [];
  try {
    const hashA = (base as { packageHash: { value: string } }).packageHash.value;
    const variantB = rehashedVariant(base, "B"), variantA2 = rehashedVariant(base, "A2");
    const hashB = variantB.packageHash.value as string, hashA2 = variantA2.packageHash.value as string;
    const seen = new Map<string, ReturnType<typeof readback>>();
    const round1 = checks(), steps1: StepRec[] = [], frames1: Record<string, string> = {};
    await timed("publish A", steps1, async () => {
      const result = await stack.controller.publish(base, { deviceEpoch: DEVICE_EPOCH });
      round1.equal("A commit", "committed", result.status);
      round1.equal("A hash 为 fixture 原包", hashA, result.identity?.packageHash);
      seen.set("A", readback(stack.deck));
      frames1["a-r1-A.png"] = seen.get("A")!.dataUrl;
      return { identity: result.identity, counts: { ...stack.counts } };
    });
    await timed("publish B（draft+改动+rehash）", steps1, async () => {
      const result = await stack.controller.publish(variantB, { deviceEpoch: DEVICE_EPOCH });
      round1.equal("B commit", "committed", result.status);
      round1.truthy("B hash 与 A 不同", result.identity?.packageHash === hashB && hashB !== hashA, result.identity?.packageHash);
      seen.set("B", readback(stack.deck));
      frames1["a-r1-B.png"] = seen.get("B")!.dataUrl;
      round1.equal("旧帧 host.release 恰 1 次", 1, stack.counts.releases);
      round1.equal("旧帧(A) GPU lease 真实 dispose", 1, stack.probes.find(probe => probe.identity.packageHash === hashA)?.gpuDisposeCalls() ?? -1);
      round1.equal("现可见帧(B) GPU lease 未被释放", 0, stack.probes.find(probe => probe.identity.packageHash === hashB)?.gpuDisposeCalls() ?? -1);
      round1.equal("deck 表面数回收（无残留表面）", 2, stack.deck.surfaceCount);
      round1.truthy("A/B 像素可区分", diffPixels(seen.get("A")!.pixels, seen.get("B")!.pixels) > DIFF_PIXEL_THRESHOLD,
        diffPixels(seen.get("A")!.pixels, seen.get("B")!.pixels));
      return { identity: result.identity, counts: { ...stack.counts } };
    });
    rounds.push({ ok: round1.list.every(item => item.pass), checks: round1.list, steps: steps1, frames: frames1 });

    const round2 = checks(), steps2: StepRec[] = [], frames2: Record<string, string> = {};
    await timed("publish A2（draft+改动+rehash）", steps2, async () => {
      const result = await stack.controller.publish(variantA2, { deviceEpoch: DEVICE_EPOCH });
      round2.equal("A2 commit", "committed", result.status);
      round2.truthy("A2 hash 独立于 A/B", result.identity?.packageHash === hashA2 && hashA2 !== hashB && hashA2 !== hashA,
        result.identity?.packageHash);
      const seenA2 = readback(stack.deck);
      frames2["a-r2-A2.png"] = seenA2.dataUrl;
      round2.equal("累计 host.release 2 次（A、B 各一）", 2, stack.counts.releases);
      round2.equal("B 帧 GPU lease 真实 dispose", 1, stack.probes.find(probe => probe.identity.packageHash === hashB)?.gpuDisposeCalls() ?? -1);
      round2.equal("现可见帧(A2) GPU lease 未被释放", 0, stack.probes.find(probe => probe.identity.packageHash === hashA2)?.gpuDisposeCalls() ?? -1);
      round2.equal("deck 表面数回收", 2, stack.deck.surfaceCount);
      round2.truthy("B/A2 像素可区分", diffPixels(seen.get("B")!.pixels, seenA2.pixels) > DIFF_PIXEL_THRESHOLD,
        diffPixels(seen.get("B")!.pixels, seenA2.pixels));
      round2.truthy("A2 可见帧有内容", seenA2.colored > 0, seenA2.colored);
      return { identity: result.identity, counts: { ...stack.counts } };
    });
    rounds.push({ ok: round2.list.every(item => item.pass), checks: round2.list, steps: steps2, frames: frames2 });
  } finally {
    finish(rounds, await stack.teardown());
  }
  return { id: "a-successive-replace", ok: rounds.every(round => round.ok), rounds };
}

/** 迟到候选：B 的 GPU 帧已渲染完成但 defer 在 prepare 返回前；宿主收到 abort/supersede 信号后 B 被拒。 */
async function groupLateCandidate(gpu: GPU, base: unknown): Promise<GroupRec> {
  const rounds: RoundRec[] = [];
  const variantB = rehashedVariant(base, "B");
  const hashB = variantB.packageHash.value as string;
  for (const mode of ["abort", "dispose"] as const) {
    const stack = await openStack(gpu);
    const round: RoundRec = { ok: false, checks: [], steps: [], frames: {} };
    rounds.push(round);
    try {
      let baseline: ReturnType<typeof readback> | undefined;
      await timed("publish A（基线）", round.steps, async () => {
        const result = await stack.controller.publish(base, { deviceEpoch: DEVICE_EPOCH });
        round.checks.push({ name: "A commit", pass: result.status === "committed", expected: "committed", actual: result.status });
        baseline = readback(stack.deck);
        round.frames[`b-${mode}-A-baseline.png`] = baseline.dataUrl;
        return { colored: baseline.colored };
      });
      const activeA = stack.deck.active;
      // 闸门装在基线 commit 之后：只拦迟到候选 B 的 prepare，不影响基线。
      const gate = stack.deferPrepare();
      let pending: Promise<{ status?: string; releaseFailures?: readonly string[] }> | undefined;
      await timed(`publish B（defer prepare，${mode} 触发）`, round.steps, async () => {
        const abort = new AbortController();
        pending = mode === "abort"
          ? stack.controller.publish(variantB, { deviceEpoch: DEVICE_EPOCH, signal: abort.signal })
          : stack.controller.publish(variantB, { deviceEpoch: DEVICE_EPOCH });
        await waitGate(gate, pending!, "组b deferPrepare");
        // 触发信号前：可见帧必须仍是 A 的表面，B 的帧未上线。
        round.checks.push({ name: "B 构建期间可见帧仍是 A 的表面", pass: stack.deck.active === activeA,
          expected: "activeA", actual: stack.deck.active === activeA ? "activeA" : "other" });
        if (mode === "abort") abort.abort(); else stack.controller.dispose();
        round.checks.push({ name: mode === "abort" ? "abort 信号后立刻看：尚无帧被 host.release" : "dispose 先回收可见 A 帧",
          pass: stack.counts.releases === (mode === "abort" ? 0 : 1),
          expected: mode === "abort" ? 0 : 1, actual: stack.counts.releases });
        gate.resume.resolve();
        const result = await pending!;
        round.checks.push({ name: mode === "abort" ? "B 状态 aborted" : "B 状态 superseded",
          pass: result.status === (mode === "abort" ? "aborted" : "superseded"),
          expected: mode === "abort" ? "aborted" : "superseded", actual: result.status });
        const expectedReleases = mode === "abort" ? 1 : 2;
        round.checks.push({ name: "迟到帧回收后 host.release 计数", pass: stack.counts.releases === expectedReleases,
          expected: expectedReleases, actual: stack.counts.releases });
        const bProbe = stack.probes.find(probe => probe.identity.packageHash === hashB);
        round.checks.push({ name: "B 帧 GPU lease 真实 dispose", pass: (bProbe?.gpuDisposeCalls() ?? -1) === 1,
          expected: 1, actual: bProbe?.gpuDisposeCalls() ?? -1 });
        if (mode === "abort") {
          round.checks.push({ name: "A 仍挂载于 deck（可见性未被迟到候选破坏）", pass: stack.deck.active === activeA,
            expected: "activeA", actual: stack.deck.active === activeA ? "activeA" : "other" });
          const aProbe = stack.probes.find(probe => probe.identity.packageHash !== hashB);
          round.checks.push({ name: "A 帧 GPU lease 未被释放", pass: (aProbe?.gpuDisposeCalls() ?? -1) === 0,
            expected: 0, actual: aProbe?.gpuDisposeCalls() ?? -1 });
          const after = readback(stack.deck);
          round.frames[`b-${mode}-A-after-reject.png`] = after.dataUrl;
          const baselineDiff = diffPixels(after.pixels, baseline!.pixels);
          round.checks.push({ name: "拒绝后可见帧像素与 A 基线一致", pass: baselineDiff === 0, expected: 0, actual: baselineDiff });
          round.checks.push({ name: "拒绝后可见帧仍有内容（呈现帧未被浏览器清空）", pass: after.colored > 0,
            expected: true, actual: after.colored });
          return { status: result.status, afterRejectColored: after.colored, counts: { ...stack.counts } };
        }
        round.checks.push({ name: "dispose 后无活动表面", pass: stack.deck.active === undefined,
          expected: "undefined", actual: stack.deck.active === undefined ? "undefined" : "lease" });
        return { status: result.status, counts: { ...stack.counts } };
      });
    } finally {
      finish([round], await stack.teardown());
    }
  }
  return { id: "b-late-candidate", ok: rounds.every(round => round.ok), rounds };
}

/** 取消：AbortSignal 在资源 load 窗口（轮1）与 GPU prepare 窗口（轮2）中止。 */
async function groupCancel(gpu: GPU, base: unknown): Promise<GroupRec> {
  const rounds: RoundRec[] = [];
  const variantB = rehashedVariant(base, "B");
  const hashB = variantB.packageHash.value as string;
  { // 轮1：load 窗口取消——无 GPU 帧分配、无可见提交
    const stack = await openStack(gpu);
    const round: RoundRec = { ok: false, checks: [], steps: [], frames: {} };
    rounds.push(round);
    try {
      const gate = stack.deferLoad();
      let pending: Promise<{ status?: string; releaseFailures?: readonly string[] }> | undefined;
      await timed("publish B（load 窗口 abort）", round.steps, async () => {
        const abort = new AbortController();
        pending = stack.controller.publish(variantB, { deviceEpoch: DEVICE_EPOCH, concurrency: 1, signal: abort.signal });
        await waitGate(gate, pending!, "组c deferLoad");
        abort.abort();
        gate.resume.resolve();
        const result = await pending!;
        round.checks.push({ name: "B 状态 aborted", pass: result.status === "aborted", expected: "aborted", actual: result.status },
          { name: "releaseFailures 为空", pass: (result.releaseFailures?.length ?? -1) === 0,
            expected: 0, actual: result.releaseFailures?.length ?? -1 },
          { name: "无 host 帧准备（GPU 分配未发生）", pass: stack.counts.prepares === 0, expected: 0, actual: stack.counts.prepares },
          { name: "无 host.release（无帧可放）", pass: stack.counts.releases === 0, expected: 0, actual: stack.counts.releases },
          { name: "无可见提交", pass: stack.counts.commits === 0, expected: 0, actual: stack.counts.commits },
          { name: "deck 仅剩初始表面", pass: stack.deck.surfaceCount === 1, expected: 1, actual: stack.deck.surfaceCount });
        return { status: result.status, counts: { ...stack.counts } };
      });
    } finally {
      finish([round], await stack.teardown());
    }
  }
  { // 轮2：GPU prepare 窗口取消——已分配的 GPU lease 必须真实关闭，基线帧保持可见
    const stack = await openStack(gpu);
    const round: RoundRec = { ok: false, checks: [], steps: [], frames: {} };
    rounds.push(round);
    try {
      await timed("publish A（基线）", round.steps, async () => {
        const result = await stack.controller.publish(base, { deviceEpoch: DEVICE_EPOCH });
        round.checks.push({ name: "A commit", pass: result.status === "committed", expected: "committed", actual: result.status });
        round.frames["c-r2-A-baseline.png"] = readback(stack.deck).dataUrl;
        return { identity: result.identity };
      });
      // 闸门装在基线 commit 之后：只拦候选 B 的 GPU prepare。
      const gate = stack.deferPrepare();
      let pending: Promise<{ status?: string; releaseFailures?: readonly string[] }> | undefined;
      await timed("publish B（prepare 窗口 abort）", round.steps, async () => {
        const activeA = stack.deck.active;
        const abort = new AbortController();
        pending = stack.controller.publish(variantB, { deviceEpoch: DEVICE_EPOCH, signal: abort.signal });
        await waitGate(gate, pending!, "组c deferPrepare");
        round.checks.push({ name: "B 帧已建立而可见帧仍为 A", pass: stack.deck.active === activeA,
          expected: "activeA", actual: stack.deck.active === activeA ? "activeA" : "other" });
        abort.abort();
        gate.resume.resolve();
        const result = await pending!;
        const bProbe = stack.probes.find(probe => probe.identity.packageHash === hashB);
        round.checks.push({ name: "B 状态 aborted", pass: result.status === "aborted", expected: "aborted", actual: result.status },
          { name: "releaseFailures 为空", pass: (result.releaseFailures?.length ?? -1) === 0,
            expected: 0, actual: result.releaseFailures?.length ?? -1 },
          { name: "B 帧 host.release 恰 1 次", pass: stack.counts.releases === 1, expected: 1, actual: stack.counts.releases },
          { name: "B 帧 GPU lease 真实 dispose（无孤立纹理的宿主级证据）", pass: (bProbe?.gpuDisposeCalls() ?? -1) === 1,
            expected: 1, actual: bProbe?.gpuDisposeCalls() ?? -1 },
          { name: "deck 表面数回收", pass: stack.deck.surfaceCount === 2, expected: 2, actual: stack.deck.surfaceCount });
        const after = readback(stack.deck);
        round.frames["c-r2-A-after-cancel.png"] = after.dataUrl;
        round.checks.push({ name: "取消后基线帧仍有内容", pass: after.colored > 0, expected: true, actual: after.colored });
        return { status: result.status, afterCancelColored: after.colored, counts: { ...stack.counts } };
      });
    } finally {
      finish([round], await stack.teardown());
    }
  }
  return { id: "c-cancel", ok: rounds.every(round => round.ok), rounds };
}

async function run(): Promise<P05Result> {
  let stage = "webgpu-probe";
  try {
    const gpu = navigator.gpu;
    if (!gpu) throw new Error("WebGPU is unavailable in this browser (navigator.gpu is undefined).");
    stage = "fetch-fixture";
    const response = await fetch("/fixture.json");
    if (!response.ok) throw new Error(`fixture fetch failed: HTTP ${response.status}`);
    const fixture = await response.json();
    stage = "group-a";
    const groups: GroupRec[] = [];
    // 诊断开关 ?only=b|c：只跑指定组（默认三组全跑）。
    const only = new URLSearchParams(location.search).get("only");
    if (only !== "b" && only !== "c") groups.push(await groupSuccessive(gpu, fixture));
    stage = "group-b";
    if (only !== "c") groups.push(await groupLateCandidate(gpu, fixture));
    stage = "group-c";
    if (only !== "b") groups.push(await groupCancel(gpu, fixture));
    stage = "adapter-info";
    const probeSession = await DeviceSession.open(Object.assign(document.createElement("canvas"),
      { width: 4, height: 4 }), gpu, new AbortController().signal);
    const adapter = probeSession.adapterInfo ?? null;
    const canvasFormat = probeSession.format;
    probeSession.dispose();
    const observations = {
      deviceLossInjection: "未覆盖：headless 下无可靠的运行中设备丢失注入路径；仅 device.destroy 主动销毁路径可验证（每组 teardown 断言 device.lost 已触发）",
      orphanTextureEvidence: "WebGPU JS API 不可枚举设备内纹理；以 host.release→Deep2dGpuLease.dispose 全链调用计数 + session 无 uncapturederror + device.lost 触发为间接证据",
      deviceLostRecords: [...lostRecords],
    };
    return { ok: groups.every(group => group.ok), adapter, canvasFormat, groups, observations };
  } catch (error) {
    return { ok: false, stage, message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined };
  }
}
void run().then((result) => { window.__P05_RESULT = result; });
