import type { DashboardDataWidgetConfig, VisionSourceRecord } from "@bim-studio/contracts";

export type DashboardMediaKind = "image" | "video" | "monitor";
export type DashboardMonitorProtocol = "hls" | "webrtc";

/**
 * UI-level media reference shared by dashboard playback and Vision sources.
 * A live source is deliberately separate from its browser-safe playback URL:
 * RTSP/RTMP/SRT go to the media gateway and are never assigned to a DOM element.
 */
export interface DashboardMediaReference {
  kind: DashboardMediaKind;
  sourceUrl?: string;
  playbackUrl?: string;
  assetId?: string;
  protocol?: DashboardMonitorProtocol;
}

export type MediaUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: "empty" | "too-long" | "control-character" | "unsupported-protocol" | "credentials" | "mixed-content" | "invalid" };
export type MediaUrlFailureReason = Exclude<MediaUrlResult, { ok: true }>["reason"];

const LIVE_PROTOCOLS = new Set(["rtsp:", "rtsps:", "rtmp:", "rtmps:", "srt:", "whep:", "wheps:", "http:", "https:", "udp+mpegts:", "udp+rtp:"]);

export function mediaReferenceFromWidget(widget: DashboardDataWidgetConfig): DashboardMediaReference | undefined {
  if (widget.type === "image") return { kind: "image", ...(widget.imageUrl ? { sourceUrl: widget.imageUrl, playbackUrl: widget.imageUrl } : {}), ...(widget.assetId ? { assetId: widget.assetId } : {}) };
  if (widget.type === "video") return { kind: "video", ...(widget.videoUrl ? { sourceUrl: widget.videoUrl, playbackUrl: widget.videoUrl } : {}), ...(widget.assetId ? { assetId: widget.assetId } : {}) };
  if (widget.type === "monitor") return {
    kind: "monitor",
    ...(widget.monitorSourceUrl ? { sourceUrl: widget.monitorSourceUrl } : {}),
    ...(widget.videoUrl ? { playbackUrl: widget.videoUrl } : {}),
    protocol: widget.monitorProtocol ?? "hls"
  };
  return undefined;
}

export function mediaReferenceFromVisionSource(source: VisionSourceRecord): DashboardMediaReference {
  return {
    kind: source.kind,
    sourceUrl: source.sourceUrl,
    playbackUrl: source.playbackUrl ?? source.sourceUrl,
    ...(source.assetId ? { assetId: source.assetId } : {})
  };
}

/** Only HTTP(S) and same-origin paths may reach img/video/iframe elements. */
export function browserMediaUrl(value: string | undefined, pageProtocol?: string): MediaUrlResult {
  const input = value?.trim() ?? "";
  if (!input) return { ok: false, reason: "empty" };
  if (input.length > 4_096) return { ok: false, reason: "too-long" };
  if (/\p{Cc}/u.test(input)) return { ok: false, reason: "control-character" };
  if (input.startsWith("/") && !input.startsWith("//")) return { ok: true, url: input };
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "unsupported-protocol" };
    if (url.username || url.password) return { ok: false, reason: "credentials" };
    if (pageProtocol === "https:" && url.protocol === "http:") return { ok: false, reason: "mixed-content" };
    return { ok: true, url: url.href };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** Validate a live ingest URL before sending it to the server-side media gateway. */
export function liveSourceUrl(value: string | undefined): MediaUrlResult {
  const input = value?.trim() ?? "";
  if (!input) return { ok: false, reason: "empty" };
  if (input.length > 4_096) return { ok: false, reason: "too-long" };
  if (/\p{Cc}/u.test(input)) return { ok: false, reason: "control-character" };
  try {
    const url = new URL(input);
    return LIVE_PROTOCOLS.has(url.protocol) ? { ok: true, url: input } : { ok: false, reason: "unsupported-protocol" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export function isHlsUrl(value: string): boolean {
  try {
    return /\.m3u8$/i.test(new URL(value, "https://studio.invalid").pathname);
  } catch {
    return false;
  }
}

export function effectivePlaybackOptions(autoplay: boolean, muted: boolean): { autoplay: boolean; muted: boolean } {
  return { autoplay, muted: autoplay || muted };
}

/** 视频音轨计划:决定播放器初始静音态与"用户手势开启声音"的确定性合同。 */
export interface VideoAudioPlan {
  /** 初始静音态:作者要求静音,或需要自动播放规避浏览器策略时必然为 true。 */
  startMuted: boolean;
  /** 自动播放被浏览器拦截后,用户手势(点击重试)内是否恢复作者的有声意愿。 */
  soundOnUserGesture: boolean;
}

/**
 * 作者静音设置与浏览器自动播放策略的合成决策。
 * 作者要求静音时保持全程静音(确定性,不提供解锁);
 * 作者未静音且自动播放时先静音起播,手势内恢复有声;
 * 作者未静音且不自动播放时,播放由用户在控制条内触发(自带手势),直接有声。
 */
export function audioTrackPlan(authorMuted: boolean, autoplay: boolean): VideoAudioPlan {
  if (authorMuted) return { startMuted: true, soundOnUserGesture: false };
  if (autoplay) return { startMuted: true, soundOnUserGesture: true };
  return { startMuted: false, soundOnUserGesture: false };
}

/** 把音量/静音合同确定性地应用到媒体元素:静音为布尔直设,音量夹取 [0,1]。 */
export function applyVideoAudioState(video: { muted: boolean; volume: number }, muted: boolean, volume: number): void {
  video.muted = muted;
  video.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
}

/** Guard repeated HLS/native readiness events from issuing concurrent play requests. */
export function shouldRequestAutoplay(autoplay: boolean, paused: boolean, readyState: number, requestPending: boolean): boolean {
  return autoplay && paused && readyState >= 1 && !requestPending;
}

export interface PlaybackWatchdogState {
  lastCurrentTime: number;
  lastProgressAt: number;
  waitingSince?: number;
  stalled: boolean;
}

export interface PlaybackWatchdogSnapshot {
  currentTime: number;
  paused: boolean;
  waiting: boolean;
  hidden: boolean;
}

export function initialPlaybackWatchdogState(now: number, currentTime = 0): PlaybackWatchdogState {
  return { lastCurrentTime: currentTime, lastProgressAt: now, stalled: false };
}

/** Pure reducer used by the live-player interval; it never tears down the active HLS session. */
export function advancePlaybackWatchdog(state: PlaybackWatchdogState, snapshot: PlaybackWatchdogSnapshot, now: number, thresholdMs = 12_000): PlaybackWatchdogState {
  const progressed = Math.abs(snapshot.currentTime - state.lastCurrentTime) >= 0.05;
  if (snapshot.hidden || snapshot.paused || progressed) {
    return { lastCurrentTime: snapshot.currentTime, lastProgressAt: now, stalled: false };
  }
  if (!snapshot.waiting) return { lastCurrentTime: snapshot.currentTime, lastProgressAt: state.lastProgressAt, stalled: false };
  const waitingSince = state.waitingSince ?? now;
  return {
    ...state,
    lastCurrentTime: snapshot.currentTime,
    waitingSince,
    stalled: now - waitingSince >= thresholdMs && now - state.lastProgressAt >= thresholdMs
  };
}

export function mediaReconnectDelay(attempt: number, baseMs = 1_000, maxMs = 8_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(10, Math.trunc(attempt))));
}

export function isPlaybackWaiting(waitingEventReceived: boolean, readyState: number): boolean {
  // HAVE_CURRENT_DATA (2) can display the last decoded frame but cannot advance.
  return waitingEventReceived || readyState < 3;
}

export function mediaUrlErrorMessage(reason: MediaUrlFailureReason, locale: "zh-CN" | "en-US" = "zh-CN"): string {
  const chinese = {
    empty: "尚未配置媒体地址",
    "too-long": "媒体地址过长",
    "control-character": "媒体地址包含非法控制字符",
    "unsupported-protocol": "浏览器播放仅允许 HTTP(S) 或站内地址",
    credentials: "播放地址不能包含明文账号密码",
    "mixed-content": "HTTPS 页面不能加载 HTTP 媒体，请为流服务启用 HTTPS",
    invalid: "媒体地址格式无效"
  } as const;
  const english = {
    empty: "No media URL configured",
    "too-long": "The media URL is too long",
    "control-character": "The media URL contains control characters",
    "unsupported-protocol": "Browser playback only accepts HTTP(S) or same-origin URLs",
    credentials: "Playback URLs must not contain plaintext credentials",
    "mixed-content": "An HTTPS page cannot load HTTP media; enable HTTPS on the media service",
    invalid: "The media URL is invalid"
  } as const;
  return (locale === "zh-CN" ? chinese : english)[reason];
}
