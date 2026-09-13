import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
import type {
  CloudRenderWorkerHealth,
  CloudRenderWorkerSessionRequest,
  RemoteRenderMediaEvidence
} from "@bim-studio/server-sdk";
import type { CloudRenderWorkerConfig } from "./config.js";
import { createProducer, installInputBinding } from "./chromiumInputBridge.js";

type Codec = "h264" | "h265" | "av1";

interface GpuProbe {
  vendor: string;
  model: string;
  memoryMiB: number;
  codecs: Codec[];
  hardware: boolean;
  evidenceSource: "runtime-loopback" | "operator-attested" | "none";
  evidenceDetail: string;
  failure?: string;
}

interface BrowserPeerStatus {
  connectionState: string;
  peerConnectionId: string;
  videoTrackId: string;
  codec?: string;
  width?: number;
  height?: number;
  framesEncoded?: number;
  framesPerSecond?: number;
  packetsSent?: number;
  bytesSent?: number;
  encoderImplementation?: string;
  powerEfficientEncoder?: boolean;
  observedAt: string;
}

interface PublicationEnvelope {
  projectId: string;
  sceneId: string;
  name: string;
  publishedAt: string;
  snapshot: Record<string, unknown>;
}

export interface RenderRuntimeSession {
  readonly offer: RTCSessionDescriptionInit;
  applyAnswer(answer: RTCSessionDescriptionInit): Promise<void>;
  mediaEvidence(): Promise<{ state: "starting" } | { state: "media-ready"; evidence: RemoteRenderMediaEvidence } | { state: "failed"; code: string }>;
  close(): Promise<void>;
}

export interface RenderRuntime {
  start(): Promise<void>;
  health(activeSessions: number): CloudRenderWorkerHealth;
  create(request: CloudRenderWorkerSessionRequest): Promise<RenderRuntimeSession>;
  close(): Promise<void>;
}

export class ChromiumRenderRuntime implements RenderRuntime {
  private browser: Browser | undefined;
  private probe: GpuProbe = { vendor: "unknown", model: "Chromium unavailable", memoryMiB: 0, codecs: [], hardware: false, evidenceSource: "none", evidenceDetail: "not_started", failure: "not_started" };

  constructor(private readonly config: CloudRenderWorkerConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async start(): Promise<void> {
    try {
      this.browser = await chromium.launch({
        executablePath: this.config.chromiumPath,
        headless: this.config.headless,
        args: [
          "--enable-gpu",
          "--ignore-gpu-blocklist",
          "--autoplay-policy=no-user-gesture-required",
          "--disable-dev-shm-usage",
          "--enable-features=VaapiVideoEncoder,VaapiVideoDecoder,WebRTCPipeWireCapturer"
        ]
      });
      this.probe = await probeGpu(this.browser, this.config.gpuMemoryMiB, this.config.verifiedHardwareCodecs);
    } catch (reason) {
      this.probe = {
        vendor: "unknown",
        model: this.config.chromiumPath,
        memoryMiB: 0,
        codecs: [],
        hardware: false,
        evidenceSource: "none",
        evidenceDetail: "Chromium launch failed",
        failure: reason instanceof Error ? reason.message : String(reason)
      };
    }
  }

  health(activeSessions: number): CloudRenderWorkerHealth {
    const ready = Boolean(this.browser && this.probe.hardware && this.probe.codecs.length > 0);
    return {
      contractVersion: 1,
      workerId: this.config.workerId,
      status: ready ? "ready" : "unavailable",
      observedAt: new Date().toISOString(),
      capacity: { maxSessions: this.config.maxSessions, activeSessions },
      gpu: {
        vendor: this.probe.vendor,
        model: this.probe.failure ? `${this.probe.model} · ${this.probe.failure}` : this.probe.model,
        memoryMiB: this.probe.memoryMiB,
        encoder: {
          hardware: this.probe.hardware,
          codecs: [...this.probe.codecs],
          evidenceSource: this.probe.evidenceSource,
          evidenceDetail: this.probe.evidenceDetail
        }
      }
    };
  }

  async create(request: CloudRenderWorkerSessionRequest): Promise<RenderRuntimeSession> {
    if (!this.browser || !this.probe.hardware || this.probe.codecs.length === 0) throw new Error("Chromium 未报告可用硬件视频编码能力");
    const publication = await validatePublication(request, this.fetchImpl);
    const context = await this.browser.newContext({ viewport: { width: request.render.width, height: request.render.height } });
    try {
      await installPublishedPageScope(context, publication);
      const internals = await context.newPage();
      await internals.goto("chrome://webrtc-internals");
      const page = await context.newPage();
      await installInputBinding(page, request.render.width, request.render.height);
      await page.goto(cloudRenderPageUrl(request.scope.renderUrl), { waitUntil: "domcontentloaded", timeout: this.config.navigationTimeoutMs });
      await page.waitForFunction(() => [...document.querySelectorAll("canvas")].some((canvas) => canvas.width > 0 && canvas.height > 0 && canvas.getBoundingClientRect().width > 0), undefined, { timeout: this.config.canvasTimeoutMs });
      const offer = await createProducer(page, request.render.framesPerSecond, request.render.codecPreferences, this.config.iceServers, this.config.iceGatheringTimeoutMs);
      return new ChromiumRuntimeSession(context, page, internals, offer, new Set(this.config.verifiedHardwareCodecs));
    } catch (reason) {
      await context.close();
      throw reason;
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }
}

/** 云视频编码依赖连续画面，即使静态场景也不能进入客户端按需休眠。 */
export function cloudRenderPageUrl(value: string): string {
  const url = new URL(value); url.searchParams.set("cloudRender", "1"); return url.toString();
}

class ChromiumRuntimeSession implements RenderRuntimeSession {
  constructor(private readonly context: BrowserContext, private readonly page: Page, private readonly internals: Page, readonly offer: RTCSessionDescriptionInit, private readonly operatorAttestedCodecs: ReadonlySet<Codec>) {}

  async applyAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (answer.type !== "answer" || typeof answer.sdp !== "string" || !answer.sdp.trim()) throw new TypeError("WebRTC answer 无效");
    await this.page.evaluate(async (description) => {
      const peer = (window as unknown as { __bimCloudRenderPeer?: { pc: RTCPeerConnection } }).__bimCloudRenderPeer;
      if (!peer) throw new Error("WebRTC producer 尚未创建");
      await peer.pc.setRemoteDescription(description);
    }, answer);
  }

  async mediaEvidence(): Promise<{ state: "starting" } | { state: "media-ready"; evidence: RemoteRenderMediaEvidence } | { state: "failed"; code: string }> {
    const status = await this.page.evaluate(async (): Promise<BrowserPeerStatus> => {
      const peer = (window as unknown as { __bimCloudRenderPeer?: { id: string; pc: RTCPeerConnection; track: MediaStreamTrack } }).__bimCloudRenderPeer;
      if (!peer) throw new Error("WebRTC producer 尚未创建");
      const stats = await peer.pc.getStats();
      let outbound: Record<string, unknown> | undefined;
      let codec: Record<string, unknown> | undefined;
      stats.forEach((report) => {
        if (report.type === "outbound-rtp" && report.kind === "video" && !report.isRemote) outbound = report as Record<string, unknown>;
      });
      if (outbound && typeof outbound.codecId === "string") codec = stats.get(outbound.codecId) as Record<string, unknown> | undefined;
      return {
        connectionState: peer.pc.connectionState,
        peerConnectionId: peer.id,
        videoTrackId: peer.track.id,
        ...(typeof codec?.mimeType === "string" ? { codec: codec.mimeType } : {}),
        ...(typeof outbound?.frameWidth === "number" ? { width: outbound.frameWidth } : {}),
        ...(typeof outbound?.frameHeight === "number" ? { height: outbound.frameHeight } : {}),
        ...(typeof outbound?.framesEncoded === "number" ? { framesEncoded: outbound.framesEncoded } : {}),
        ...(typeof outbound?.framesPerSecond === "number" ? { framesPerSecond: outbound.framesPerSecond } : {}),
        ...(typeof outbound?.packetsSent === "number" ? { packetsSent: outbound.packetsSent } : {}),
        ...(typeof outbound?.bytesSent === "number" ? { bytesSent: outbound.bytesSent } : {}),
        ...(typeof outbound?.encoderImplementation === "string" ? { encoderImplementation: outbound.encoderImplementation } : {}),
        ...(typeof outbound?.powerEfficientEncoder === "boolean" ? { powerEfficientEncoder: outbound.powerEfficientEncoder } : {}),
        observedAt: new Date().toISOString()
      };
    });
    if (["failed", "closed"].includes(status.connectionState)) return { state: "failed", code: `webrtc_${status.connectionState}` };
    const codec = normalizeCodec(status.codec);
    if (!codec || !positive(status.width) || !positive(status.height) || !positive(status.framesEncoded) || !positive(status.packetsSent) || !positive(status.bytesSent)) {
      return { state: "starting" };
    }
    const internalsEvidence = extractWebRtcInternalsHardwareEvidence(await this.internals.locator("body").innerText().catch(() => ""));
    const encoderImplementation = status.encoderImplementation ?? internalsEvidence.encoderImplementation;
    const powerEfficientEncoder = status.powerEfficientEncoder ?? internalsEvidence.powerEfficientEncoder;
    const runtimeHardware = isHardwareEncoderStats(encoderImplementation, powerEfficientEncoder);
    const operatorAttested = this.operatorAttestedCodecs.has(codec);
    if (!runtimeHardware && !operatorAttested) {
      if (isExplicitSoftwareEncoderStats(encoderImplementation, powerEfficientEncoder)) return { state: "failed", code: "software_encoder_detected" };
      return { state: "starting" };
    }
    return {
      state: "media-ready",
      evidence: {
        kind: "webrtc-outbound-rtp",
        observedAt: status.observedAt,
        peerConnectionId: status.peerConnectionId,
        videoTrackId: status.videoTrackId,
        codec,
        hardwareEncoder: true,
        encoderImplementation: encoderImplementation?.trim() || (operatorAttested ? "operator-attested" : "hardware-encoder"),
        encoderEvidence: runtimeHardware ? "runtime-stats" : "operator-attested",
        width: status.width,
        height: status.height,
        framesEncoded: status.framesEncoded,
        ...(typeof status.framesPerSecond === "number" && Number.isFinite(status.framesPerSecond) && status.framesPerSecond >= 0 ? { framesPerSecond: status.framesPerSecond } : {}),
        packetsSent: status.packetsSent,
        bytesSent: status.bytesSent
      }
    };
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

interface LoopbackCodecResult {
  codec: Codec;
  encoded: boolean;
  encoderImplementation?: string;
  powerEfficientEncoder?: boolean;
  framesEncoded: number;
  packetsSent: number;
  bytesSent: number;
}

async function probeGpu(browser: Browser, configuredMemoryMiB: number | undefined, operatorAttestedCodecs: Codec[]): Promise<GpuProbe> {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = await session.send("SystemInfo.getInfo") as unknown as Record<string, unknown>;
    const gpu = object(result.gpu);
    const devices = Array.isArray(gpu?.devices) ? gpu.devices : [];
    const primary = object(devices[0]);
    const featureStatus = object(gpu?.featureStatus);
    const videoEncodeFeature = firstNonEmpty(featureStatus?.video_encode, featureStatus?.videoEncode, "not-reported");
    const loopback = await runLoopbackEncoderProbe(browser);
    const runtimeCodecs = loopback.filter((entry) => entry.encoded && isHardwareEncoderStats(entry.encoderImplementation, entry.powerEfficientEncoder)).map((entry) => entry.codec);
    const codecs = [...new Set([...runtimeCodecs, ...operatorAttestedCodecs])];
    const attestationUsed = codecs.some((codec) => !runtimeCodecs.includes(codec));
    const aux = object(gpu?.auxAttributes);
    const evidenceDetail = [
      `CDP video_encode=${videoEncodeFeature}`,
      ...loopback.map((item) => `${item.codec}:${item.encoded ? `${item.framesEncoded}f/${item.packetsSent}p/${item.bytesSent}b` : "no-rtp"}:${item.encoderImplementation ?? "implementation-unreported"}:${item.powerEfficientEncoder === true ? "power-efficient" : "power-unconfirmed"}`),
      ...(attestationUsed ? [`operator-attested=${operatorAttestedCodecs.join(",")}`] : [])
    ].join(" · ");
    return {
      vendor: firstNonEmpty(primary?.vendorString, primary?.driverVendor, "unknown"),
      model: firstNonEmpty(primary?.deviceString, "unknown GPU"),
      memoryMiB: configuredMemoryMiB ?? parseMemoryMiB(aux) ?? 0,
      codecs,
      hardware: codecs.length > 0,
      evidenceSource: codecs.length === 0 ? "none" : attestationUsed ? "operator-attested" : "runtime-loopback",
      evidenceDetail,
      ...(codecs.length === 0 ? { failure: "WebRTC loopback 未证明硬件编码；可在运维实测后配置 CLOUD_RENDER_VERIFIED_HARDWARE_CODECS" } : {})
    };
  } finally {
    await session.detach();
  }
}

async function runLoopbackEncoderProbe(browser: Browser): Promise<LoopbackCodecResult[]> {
  const context = await browser.newContext();
  const internals = await context.newPage();
  const page = await context.newPage();
  try {
    await internals.goto("chrome://webrtc-internals");
    const targets = await page.evaluate(() => {
      const capabilities = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
      return (["h264", "av1", "h265"] as const).filter((target) => capabilities.some((codec) => {
        const mime = codec.mimeType.toLowerCase();
        return target === "h264" ? mime.includes("h264") : target === "h265" ? mime.includes("h265") || mime.includes("hevc") : mime.includes("av1");
      }));
    });
    const results: LoopbackCodecResult[] = [];
    for (const codec of targets) {
      const result = await page.evaluate(async (codec): Promise<LoopbackCodecResult> => {
        const capabilities = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
        const sender = new RTCPeerConnection();
        const receiver = new RTCPeerConnection();
        const canvas = document.createElement("canvas");
        canvas.width = 320; canvas.height = 240;
        const drawing = canvas.getContext("2d");
        if (!drawing) return { codec, encoded: false, framesEncoded: 0, packetsSent: 0, bytesSent: 0 };
        const drawingContext = drawing;
        let frame = 0;
        const drawingInterval = window.setInterval(() => {
          drawingContext.fillStyle = `hsl(${frame % 360} 70% 45%)`; drawingContext.fillRect(0, 0, canvas.width, canvas.height);
          drawingContext.fillStyle = "white"; drawingContext.font = "28px sans-serif"; drawingContext.fillText(String(frame), 18, 42);
          frame += 1;
        }, 16);
        const stream = canvas.captureStream(30);
        const track = stream.getVideoTracks()[0]!;
        const transceiver = sender.addTransceiver(track, { direction: "sendonly", streams: [stream] });
        const preferred = capabilities.filter((candidate) => {
          const mime = candidate.mimeType.toLowerCase();
          return codec === "h264" ? mime.includes("h264") : codec === "h265" ? mime.includes("h265") || mime.includes("hevc") : mime.includes("av1");
        });
        transceiver.setCodecPreferences([...preferred, ...capabilities.filter((candidate) => /rtx|red|ulpfec/i.test(candidate.mimeType))]);
        const video = document.createElement("video"); video.muted = true; video.autoplay = true; video.playsInline = true;
        receiver.ontrack = (event) => { if (event.streams[0]) video.srcObject = event.streams[0]; void video.play().catch(() => undefined); };
        (window as unknown as { __bimEncoderProbe?: { sender: RTCPeerConnection; receiver: RTCPeerConnection; track: MediaStreamTrack; video: HTMLVideoElement; drawingInterval: number } }).__bimEncoderProbe = { sender, receiver, track, video, drawingInterval };
        try {
          await sender.setLocalDescription(await sender.createOffer());
          if (sender.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => reject(new Error("ICE gathering timeout")), 3_000);
            sender.addEventListener("icegatheringstatechange", () => { if (sender.iceGatheringState === "complete") { window.clearTimeout(timeout); resolve(); } });
          });
          await receiver.setRemoteDescription(sender.localDescription!);
          await receiver.setLocalDescription(await receiver.createAnswer());
          if (receiver.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => reject(new Error("ICE gathering timeout")), 3_000);
            receiver.addEventListener("icegatheringstatechange", () => { if (receiver.iceGatheringState === "complete") { window.clearTimeout(timeout); resolve(); } });
          });
          await sender.setRemoteDescription(receiver.localDescription!);
          const deadline = performance.now() + 5_000;
          let found: LoopbackCodecResult | undefined;
          while (performance.now() < deadline) {
            const stats = await sender.getStats();
            stats.forEach((report) => {
              if (report.type !== "outbound-rtp" || report.kind !== "video" || report.isRemote) return;
              const framesEncoded = Number(report.framesEncoded ?? 0);
              const packetsSent = Number(report.packetsSent ?? 0);
              const bytesSent = Number(report.bytesSent ?? 0);
              found = {
                codec,
                encoded: framesEncoded > 0 && packetsSent > 0 && bytesSent > 0,
                framesEncoded,
                packetsSent,
                bytesSent,
                ...(typeof report.encoderImplementation === "string" ? { encoderImplementation: report.encoderImplementation } : {}),
                ...(typeof report.powerEfficientEncoder === "boolean" ? { powerEfficientEncoder: report.powerEfficientEncoder } : {})
              };
            });
            if (found?.encoded) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return found ?? { codec, encoded: false, framesEncoded: 0, packetsSent: 0, bytesSent: 0 };
        } catch {
          window.clearInterval(drawingInterval); track.stop(); sender.close(); receiver.close(); video.remove();
          delete (window as unknown as { __bimEncoderProbe?: unknown }).__bimEncoderProbe;
          return { codec, encoded: false, framesEncoded: 0, packetsSent: 0, bytesSent: 0 };
        }
      }, codec);
      if (result.encoded) {
        await internals.waitForTimeout(2_500);
        await internals.waitForFunction(() => document.body.innerText.includes("encoderImplementation"), undefined, { timeout: 5_000 }).catch(() => undefined);
      }
      const evidence = extractWebRtcInternalsHardwareEvidence(await internals.locator("body").innerText().catch(() => ""));
      const refreshed = await page.evaluate(async (): Promise<Partial<LoopbackCodecResult>> => {
        const probe = (window as unknown as { __bimEncoderProbe?: { sender: RTCPeerConnection } }).__bimEncoderProbe;
        if (!probe) return {};
        const stats = await probe.sender.getStats();
        let value: Partial<LoopbackCodecResult> = {};
        stats.forEach((report) => {
          if (report.type === "outbound-rtp" && report.kind === "video" && !report.isRemote) value = {
            framesEncoded: Number(report.framesEncoded ?? 0),
            packetsSent: Number(report.packetsSent ?? 0),
            bytesSent: Number(report.bytesSent ?? 0)
          };
        });
        return value;
      });
      results.push({
        ...result,
        ...refreshed,
        ...(evidence.encoderImplementation ? { encoderImplementation: evidence.encoderImplementation } : {}),
        ...(evidence.powerEfficientEncoder !== undefined ? { powerEfficientEncoder: evidence.powerEfficientEncoder } : {})
      });
      await page.evaluate(() => {
        const owner = window as unknown as { __bimEncoderProbe?: { sender: RTCPeerConnection; receiver: RTCPeerConnection; track: MediaStreamTrack; video: HTMLVideoElement; drawingInterval: number } };
        const probe = owner.__bimEncoderProbe;
        if (!probe) return;
        window.clearInterval(probe.drawingInterval); probe.track.stop(); probe.sender.close(); probe.receiver.close(); probe.video.remove(); delete owner.__bimEncoderProbe;
      });
    }
    return results;
  } finally {
    await context.close();
  }
}

async function validatePublication(request: CloudRenderWorkerSessionRequest, fetchImpl: typeof fetch): Promise<PublicationEnvelope> {
  const response = await fetchImpl(request.scope.publicationUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`无法加载发布快照：HTTP ${response.status}`);
  const publication = object(await response.json());
  if (publication?.projectId !== request.scope.projectId || publication.sceneId !== request.scope.sceneId || publication.publishedAt !== request.scope.publishedAt) {
    throw new Error("发布快照身份与 Worker 请求不一致");
  }
  const snapshot = object(publication.snapshot);
  if (snapshot?.id !== request.scope.sceneId || snapshot.projectId !== request.scope.projectId || snapshot.publishedAt !== request.scope.publishedAt) {
    throw new Error("发布快照内容与 Worker 请求不一致");
  }
  return {
    projectId: request.scope.projectId,
    sceneId: request.scope.sceneId,
    name: typeof publication.name === "string" ? publication.name : request.scope.sceneId,
    publishedAt: request.scope.publishedAt,
    snapshot
  };
}

async function installPublishedPageScope(context: BrowserContext, publication: PublicationEnvelope): Promise<void> {
  await context.addInitScript(() => {
    sessionStorage.setItem("bim-studio-auth-token", "cloud-render-published-scope");
  });
  await context.route("**/api/**", async (route) => handlePublishedApiRoute(route, publication));
}

async function handlePublishedApiRoute(route: Route, publication: PublicationEnvelope): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const projectPath = `/api/projects/${encodeURIComponent(publication.projectId)}`;
  const json = (value: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  if (request.method() !== "GET") return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "云渲染发布作用域只读" }) });
  if (url.pathname === "/api/auth/me") return json({
    id: "cloud-render-worker",
    username: "cloud-render-worker",
    displayName: "云渲染发布会话",
    role: "viewer",
    projectIds: [publication.projectId],
    enabled: true,
    createdAt: publication.publishedAt,
    updatedAt: publication.publishedAt
  });
  const project = {
    id: publication.projectId,
    name: publication.name,
    description: "Cloud render published scope",
    models: [],
    createdAt: publication.publishedAt,
    updatedAt: publication.publishedAt
  };
  if (url.pathname === "/api/projects") return json([project]);
  if (url.pathname === projectPath) return json(project);
  if (url.pathname === `${projectPath}/scenes`) return json([publication.snapshot]);
  if (url.pathname === "/api/meta" || url.pathname.startsWith("/api/public/")) return route.continue();
  return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "请求超出云渲染发布作用域" }) });
}

function normalizeCodec(value: string | undefined): Codec | undefined {
  const codec = value?.toLowerCase() ?? "";
  if (codec.includes("h264") || codec.includes("avc")) return "h264";
  if (codec.includes("h265") || codec.includes("hevc")) return "h265";
  if (codec.includes("av1")) return "av1";
  return undefined;
}

export function isHardwareEncoderStats(implementation: string | undefined, powerEfficientEncoder: boolean | undefined): boolean {
  const normalized = implementation?.trim().toLowerCase() ?? "";
  if (!normalized || /libvpx|libaom|openh264|software|ffmpeg|cpu/.test(normalized)) return false;
  return powerEfficientEncoder === true;
}

export function isExplicitSoftwareEncoderStats(implementation: string | undefined, powerEfficientEncoder: boolean | undefined): boolean {
  const normalized = implementation?.trim().toLowerCase() ?? "";
  if (!normalized) return false;
  return /libvpx|libaom|openh264|software|ffmpeg|cpu/.test(normalized) || powerEfficientEncoder === false;
}

export function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "unknown";
}

export function extractWebRtcInternalsHardwareEvidence(text: string): { encoderImplementation?: string; powerEfficientEncoder?: boolean } {
  const implementations = [...text.matchAll(/encoderImplementation\s*(?:=|\r?\n)\s*([^,\r\n]+)/gi)];
  const powerValues = [...text.matchAll(/powerEfficientEncoder\s*(?:=|\r?\n)\s*(true|false)/gi)];
  const encoderImplementation = implementations.at(-1)?.[1]?.trim();
  const powerValue = powerValues.at(-1)?.[1]?.toLowerCase();
  return {
    ...(encoderImplementation ? { encoderImplementation } : {}),
    ...(powerValue === "true" || powerValue === "false" ? { powerEfficientEncoder: powerValue === "true" } : {})
  };
}

function parseMemoryMiB(aux: Record<string, unknown> | undefined): number | undefined {
  if (!aux) return undefined;
  const entry = Object.entries(aux).find(([key]) => /video.*memory|memory.*size/i.test(key));
  if (!entry) return undefined;
  const value = String(entry[1]);
  const match = value.match(/([\d.]+)\s*(MB|MiB|GB|GiB)/i);
  if (!match?.[1] || !match[2]) return undefined;
  const amount = Number(match[1]);
  return Math.round(amount * (/^g/i.test(match[2]) ? 1024 : 1));
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positive(value: number | undefined): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
