import type { BrowserContext, Page } from "playwright-core";
import type { RemoteRenderMediaEvidence } from "@bim-studio/server-sdk";
import type { RenderRuntimeSession } from "./chromiumRuntime.js";

export type Codec = "h264" | "h265" | "av1";

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

export class ChromiumRuntimeSession implements RenderRuntimeSession {
  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly internals: Page,
    readonly offer: RTCSessionDescriptionInit,
    private readonly operatorAttestedCodecs: ReadonlySet<Codec>,
  ) {}

  async applyAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (answer.type !== "answer" || typeof answer.sdp !== "string" || !answer.sdp.trim())
      throw new TypeError("WebRTC answer 无效");
    await this.page.evaluate(async (description) => {
      const peer = (window as unknown as { __bimCloudRenderPeer?: { pc: RTCPeerConnection } }).__bimCloudRenderPeer;
      if (!peer) throw new Error("WebRTC producer 尚未创建");
      await peer.pc.setRemoteDescription(description);
    }, answer);
  }

  async mediaEvidence(): Promise<
    | { state: "starting" }
    | { state: "media-ready"; evidence: RemoteRenderMediaEvidence }
    | { state: "failed"; code: string }
  > {
    const status = await this.page.evaluate(async (): Promise<BrowserPeerStatus> => {
      const peer = (window as unknown as {
        __bimCloudRenderPeer?: { id: string; pc: RTCPeerConnection; track: MediaStreamTrack };
      }).__bimCloudRenderPeer;
      if (!peer) throw new Error("WebRTC producer 尚未创建");
      const stats = await peer.pc.getStats();
      let outbound: Record<string, unknown> | undefined;
      let codec: Record<string, unknown> | undefined;
      stats.forEach((report) => {
        if (report.type === "outbound-rtp" && report.kind === "video" && !report.isRemote)
          outbound = report as Record<string, unknown>;
      });
      if (outbound && typeof outbound.codecId === "string")
        codec = stats.get(outbound.codecId) as Record<string, unknown> | undefined;
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
        ...(typeof outbound?.encoderImplementation === "string"
          ? { encoderImplementation: outbound.encoderImplementation }
          : {}),
        ...(typeof outbound?.powerEfficientEncoder === "boolean"
          ? { powerEfficientEncoder: outbound.powerEfficientEncoder }
          : {}),
        observedAt: new Date().toISOString(),
      };
    });
    if (["failed", "closed"].includes(status.connectionState))
      return { state: "failed", code: `webrtc_${status.connectionState}` };
    const codec = normalizeCodec(status.codec);
    if (
      !codec ||
      !positive(status.width) ||
      !positive(status.height) ||
      !positive(status.framesEncoded) ||
      !positive(status.packetsSent) ||
      !positive(status.bytesSent)
    ) {
      return { state: "starting" };
    }
    const internalsEvidence = extractWebRtcInternalsHardwareEvidence(
      await this.internals.locator("body").innerText().catch(() => ""),
    );
    const encoderImplementation = status.encoderImplementation ?? internalsEvidence.encoderImplementation;
    const powerEfficientEncoder = status.powerEfficientEncoder ?? internalsEvidence.powerEfficientEncoder;
    const runtimeHardware = isHardwareEncoderStats(encoderImplementation, powerEfficientEncoder);
    const operatorAttested = this.operatorAttestedCodecs.has(codec);
    if (!runtimeHardware && !operatorAttested) {
      if (isExplicitSoftwareEncoderStats(encoderImplementation, powerEfficientEncoder))
        return { state: "failed", code: "software_encoder_detected" };
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
        encoderImplementation:
          encoderImplementation?.trim() ||
          (operatorAttested ? "operator-attested" : "hardware-encoder"),
        encoderEvidence: runtimeHardware ? "runtime-stats" : "operator-attested",
        width: status.width,
        height: status.height,
        framesEncoded: status.framesEncoded,
        ...(typeof status.framesPerSecond === "number" &&
        Number.isFinite(status.framesPerSecond) &&
        status.framesPerSecond >= 0
          ? { framesPerSecond: status.framesPerSecond }
          : {}),
        packetsSent: status.packetsSent,
        bytesSent: status.bytesSent,
      },
    };
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

function normalizeCodec(value: string | undefined): Codec | undefined {
  const codec = value?.toLowerCase() ?? "";
  if (codec.includes("h264") || codec.includes("avc")) return "h264";
  if (codec.includes("h265") || codec.includes("hevc")) return "h265";
  if (codec.includes("av1")) return "av1";
  return undefined;
}

export function isHardwareEncoderStats(
  implementation: string | undefined,
  powerEfficientEncoder: boolean | undefined,
): boolean {
  const normalized = implementation?.trim().toLowerCase() ?? "";
  if (!normalized || /libvpx|libaom|openh264|software|ffmpeg|cpu/.test(normalized)) return false;
  return powerEfficientEncoder === true;
}

export function isExplicitSoftwareEncoderStats(
  implementation: string | undefined,
  powerEfficientEncoder: boolean | undefined,
): boolean {
  const normalized = implementation?.trim().toLowerCase() ?? "";
  if (!normalized) return false;
  return (
    /libvpx|libaom|openh264|software|ffmpeg|cpu/.test(normalized) ||
    powerEfficientEncoder === false
  );
}

export function extractWebRtcInternalsHardwareEvidence(
  text: string,
): { encoderImplementation?: string; powerEfficientEncoder?: boolean } {
  const implementations = [
    ...text.matchAll(/encoderImplementation\s*(?:=|\r?\n)\s*([^,\r\n]+)/gi),
  ];
  const powerValues = [
    ...text.matchAll(/powerEfficientEncoder\s*(?:=|\r?\n)\s*(true|false)/gi),
  ];
  const encoderImplementation = implementations.at(-1)?.[1]?.trim();
  const powerValue = powerValues.at(-1)?.[1]?.toLowerCase();
  return {
    ...(encoderImplementation ? { encoderImplementation } : {}),
    ...(powerValue === "true" || powerValue === "false"
      ? { powerEfficientEncoder: powerValue === "true" }
      : {}),
  };
}

function positive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
