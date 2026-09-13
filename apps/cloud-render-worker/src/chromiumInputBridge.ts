import type { Page } from "playwright-core";
import { createInputQueue } from "./chromiumInputQueue.js";

type Codec = "h264" | "h265" | "av1";

export type InputEvent =
  | { type: "pointer"; action: "move" | "down" | "up"; x: number; y: number; button: "left" | "middle" | "right" }
  | { type: "wheel"; deltaX: number; deltaY: number }
  | { type: "key"; action: "down" | "up"; key: string };

export async function installInputBinding(page: Page, width: number, height: number): Promise<void> {
  const queue = createInputQueue(page, width, height, error => console.warn("云渲染输入执行失败", error instanceof Error ? error.message : String(error)));
  page.on("close", queue.close);
  await page.exposeFunction("__bimCloudRenderInput", (raw: unknown) => {
    const input = parseInput(raw);
    if (input) queue.enqueue(input);
  });
}

export async function createProducer(page: Page, framesPerSecond: number, codecPreferences: Codec[], iceServers: unknown[], iceTimeoutMs: number): Promise<RTCSessionDescriptionInit> {
  return page.evaluate(async ({ framesPerSecond, codecPreferences, iceServers, iceTimeoutMs }) => {
    const canvases = [...document.querySelectorAll("canvas")].filter((canvas) => canvas.width > 0 && canvas.height > 0);
    const canvas = canvases.sort((left, right) => right.getBoundingClientRect().width * right.getBoundingClientRect().height - left.getBoundingClientRect().width * left.getBoundingClientRect().height)[0];
    if (!canvas || typeof canvas.captureStream !== "function") throw new Error("发布页面没有可捕获的渲染 canvas");
    const stream = canvas.captureStream(framesPerSecond);
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("canvas 未产生视频轨道");
    const pc = new RTCPeerConnection({ iceServers: iceServers as RTCIceServer[] });
    const transceiver = pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
    const capabilities = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
    const mediaCodecs = capabilities.filter((candidate) => codecPreferences.some((codec) => {
      const mime = candidate.mimeType.toLowerCase();
      return codec === "h264" ? mime.includes("h264") : codec === "h265" ? mime.includes("h265") || mime.includes("hevc") : mime.includes("av1");
    }));
    if (mediaCodecs.length === 0) throw new Error("Chromium WebRTC 未暴露请求的硬件编码格式");
    transceiver.setCodecPreferences([...mediaCodecs, ...capabilities.filter((codec) => /rtx|red|ulpfec/i.test(codec.mimeType))]);
    const input = pc.createDataChannel("input", { ordered: true });
    input.addEventListener("message", (event) => {
      let value: unknown;
      try { value = JSON.parse(String(event.data)); } catch { return; }
      void (window as unknown as { __bimCloudRenderInput: (payload: unknown) => Promise<void> }).__bimCloudRenderInput(value).catch(() => undefined);
    });
    const id = crypto.randomUUID();
    (window as unknown as { __bimCloudRenderPeer: { id: string; pc: RTCPeerConnection; track: MediaStreamTrack } }).__bimCloudRenderPeer = { id, pc, track };
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("ICE gathering timeout")), iceTimeoutMs);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") { window.clearTimeout(timeout); resolve(); }
      });
    });
    if (!pc.localDescription) throw new Error("WebRTC offer 创建失败");
    return { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
  }, { framesPerSecond, codecPreferences, iceServers, iceTimeoutMs });
}

/** 远端输入只接受有限事件和归一化坐标，防止数据通道把任意对象送入 Playwright。 */
export function parseInput(raw: unknown): InputEvent | undefined {
  const value = object(raw);
  if (!value) return undefined;
  if (value.type === "pointer" && ["move", "down", "up"].includes(String(value.action))) {
    const x = Number(value.x); const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    const button = ["left", "middle", "right"].includes(String(value.button)) ? value.button as "left" | "middle" | "right" : "left";
    return { type: "pointer", action: value.action as "move" | "down" | "up", x: clamp(x), y: clamp(y), button };
  }
  if (value.type === "wheel") {
    const deltaX = Number(value.deltaX); const deltaY = Number(value.deltaY);
    if (Number.isFinite(deltaX) && Number.isFinite(deltaY)) return { type: "wheel", deltaX: limit(deltaX, 2_000), deltaY: limit(deltaY, 2_000) };
  }
  if (value.type === "key" && ["down", "up"].includes(String(value.action)) && typeof value.key === "string" && value.key.length <= 32) {
    return { type: "key", action: value.action as "down" | "up", key: value.key };
  }
  return undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function clamp(value: number): number { return Math.min(1, Math.max(0, value)); }
function limit(value: number, maximum: number): number { return Math.min(maximum, Math.max(-maximum, value)); }
