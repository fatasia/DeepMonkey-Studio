import { createHash } from "node:crypto";
import path from "node:path";
import type {
  VisionPlaybackProtocol,
  VisionSourceProtocol,
  VisionSourceRecord,
} from "@bim-studio/contracts";

export interface VisionStreamResolution {
  playbackUrl: string;
  playbackProtocol: "hls" | "webrtc";
  frameUrl: string;
}

const STREAM_SCHEMES: Record<Exclude<VisionSourceProtocol, "upload">, Set<string>> = {
  rtsp: new Set(["rtsp:", "rtsps:"]),
  rtmp: new Set(["rtmp:", "rtmps:"]),
  srt: new Set(["srt:"]),
  hls: new Set(["http:", "https:"]),
  webrtc: new Set(["http:", "https:", "whep:", "wheps:"]),
};

export function validateVisionStreamUrl(value: string, protocol: Exclude<VisionSourceProtocol, "upload">): URL {
  if (!value || value.length > 4_096 || /\p{Cc}/u.test(value)) throw new Error("监控源地址无效");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("监控源地址格式无效");
  }
  if (!STREAM_SCHEMES[protocol].has(parsed.protocol)) throw new Error(`${protocol.toUpperCase()} 源协议与地址不匹配`);
  if (protocol === "hls" && !/\.m3u8$/i.test(parsed.pathname)) throw new Error("HLS 源必须指向 .m3u8 播放列表");
  return parsed;
}

export function inferVisionSourceProtocol(value: string): Exclude<VisionSourceProtocol, "upload"> {
  const protocol = new URL(value).protocol.toLowerCase();
  if (protocol === "rtsp:" || protocol === "rtsps:") return "rtsp";
  if (protocol === "rtmp:" || protocol === "rtmps:") return "rtmp";
  if (protocol === "srt:") return "srt";
  if (protocol === "whep:" || protocol === "wheps:") return "webrtc";
  return "hls";
}

export async function resolveVisionStream(
  sourceUrl: string,
  protocol: Exclude<VisionSourceProtocol, "upload">,
  playbackProtocol: Exclude<VisionPlaybackProtocol, "file">,
  host: string,
): Promise<VisionStreamResolution> {
  const parsed = validateVisionStreamUrl(sourceUrl, protocol);
  if (protocol === "hls" && playbackProtocol === "hls") {
    return { playbackUrl: parsed.toString(), playbackProtocol: "hls", frameUrl: parsed.toString() };
  }

  const streamPath = `vision-${createHash("sha256").update(sourceUrl).digest("hex").slice(0, 16)}`;
  const controlBase = (process.env.MEDIA_GATEWAY_CONTROL_URL ?? "http://127.0.0.1:9997").replace(/\/$/, "");
  const configuration = { source: sourceUrl, sourceOnDemand: true };
  const response = await fetch(`${controlBase}/v3/config/paths/add/${encodeURIComponent(streamPath)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(configuration),
    signal: AbortSignal.timeout(5_000),
  }).catch((reason) => {
    throw new Error(`视觉媒体网关不可用：${reason instanceof Error ? reason.message : String(reason)}`);
  });
  if (!response.ok && response.status !== 400) throw new Error(`视觉媒体网关配置失败：HTTP ${response.status}`);
  if (response.status === 400) {
    const patched = await fetch(`${controlBase}/v3/config/paths/patch/${encodeURIComponent(streamPath)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(configuration),
      signal: AbortSignal.timeout(5_000),
    });
    if (!patched.ok) throw new Error(`视觉媒体网关更新失败：HTTP ${patched.status}`);
  }
  const hlsBase = (process.env.MEDIA_GATEWAY_HLS_URL ?? `https://${host}:8888`).replace(/\/$/, "");
  const webRtcBase = (process.env.MEDIA_GATEWAY_WEBRTC_URL ?? `https://${host}:8889`).replace(/\/$/, "");
  const hlsUrl = `${hlsBase}/${streamPath}/index.m3u8`;
  return {
    playbackUrl: playbackProtocol === "webrtc" ? `${webRtcBase}/${streamPath}` : hlsUrl,
    playbackProtocol,
    // FFmpeg 不直接消费浏览器 WHEP 会话，统一从同一媒体网关的 HLS 出口抽帧。
    frameUrl: hlsUrl,
  };
}

export function visionUploadContentType(fileName: string): { kind: "image" | "video"; mimeType: string } | undefined {
  const extension = path.extname(fileName).toLowerCase();
  const imageTypes: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  };
  const videoTypes: Record<string, string> = {
    ".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".m4v": "video/x-m4v",
  };
  if (imageTypes[extension]) return { kind: "image", mimeType: imageTypes[extension] };
  if (videoTypes[extension]) return { kind: "video", mimeType: videoTypes[extension] };
  return undefined;
}

export function cleanVisionFileName(value: string): string {
  return path.basename(value).replace(/[^\p{L}\p{N}._ -]+/gu, "-").slice(0, 180) || "source.bin";
}

export function visionSourceFilePath(dataDir: string, projectId: string, source: VisionSourceRecord): string | undefined {
  if (source.protocol !== "upload" || !source.fileName) return undefined;
  const root = path.resolve(dataDir, "projects", projectId, "vision", "sources", source.id);
  const resolved = path.resolve(root, source.fileName);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("视觉源文件路径越界");
  return resolved;
}
