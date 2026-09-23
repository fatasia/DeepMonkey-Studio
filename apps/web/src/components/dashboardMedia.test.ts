import { describe, expect, it, vi } from "vitest";
import type { DashboardDataWidgetConfig, VisionSourceRecord } from "@bim-studio/contracts";
import { advancePlaybackWatchdog, applyVideoAudioState, audioTrackPlan, browserMediaUrl, effectivePlaybackOptions, initialPlaybackWatchdogState, isHlsUrl, isPlaybackWaiting, liveSourceUrl, mediaReconnectDelay, mediaReferenceFromVisionSource, mediaReferenceFromWidget, shouldRequestAutoplay } from "./dashboardMedia";

describe("dashboard media references", () => {
  it("keeps live ingest separate from its browser playback URL", () => {
    const widget = { title: "Camera", key: "", unit: "", type: "monitor", monitorSourceUrl: "rtsp://camera.local/live", videoUrl: "https://media.local/camera/index.m3u8", monitorProtocol: "hls" } satisfies DashboardDataWidgetConfig;

    expect(mediaReferenceFromWidget(widget)).toEqual({
      kind: "monitor",
      sourceUrl: "rtsp://camera.local/live",
      playbackUrl: "https://media.local/camera/index.m3u8",
      protocol: "hls"
    });
  });

  it("adapts a Vision source without requiring a Vision task", () => {
    const source: VisionSourceRecord = {
      id: "source-1", projectId: "project-1", name: "Line camera", kind: "video",
      sourceUrl: "rtsp://camera.local/live", playbackUrl: "https://media.local/line/index.m3u8",
      status: "online", createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z"
    };

    expect(mediaReferenceFromVisionSource(source)).toMatchObject({ kind: "video", sourceUrl: source.sourceUrl, playbackUrl: source.playbackUrl });
  });
});

describe("dashboard media URL safety", () => {
  it("allows same-origin and credential-free HTTP(S) playback URLs", () => {
    expect(browserMediaUrl("/assets/video.mp4", "https:")).toEqual({ ok: true, url: "/assets/video.mp4" });
    expect(browserMediaUrl("https://cdn.example/video.mp4", "https:")).toEqual({ ok: true, url: "https://cdn.example/video.mp4" });
  });

  it("blocks executable, credential-bearing, and mixed-content playback URLs", () => {
    expect(browserMediaUrl("javascript:alert(1)")).toMatchObject({ ok: false, reason: "unsupported-protocol" });
    expect(browserMediaUrl("https://user:secret@camera.example/live")).toMatchObject({ ok: false, reason: "credentials" });
    expect(browserMediaUrl("http://media.example/live.m3u8", "https:")).toMatchObject({ ok: false, reason: "mixed-content" });
  });

  it("accepts supported gateway ingest protocols but rejects local browser schemes", () => {
    expect(liveSourceUrl("rtsp://camera.local/live")).toMatchObject({ ok: true });
    expect(liveSourceUrl("srt://gateway.local:9000?streamid=line-1")).toMatchObject({ ok: true });
    expect(liveSourceUrl("file:///camera.mp4")).toMatchObject({ ok: false, reason: "unsupported-protocol" });
  });
});

describe("dashboard video policy", () => {
  it("detects HLS using the URL path even with a query string", () => {
    expect(isHlsUrl("https://media.example/live/index.m3u8?token=abc")).toBe(true);
    expect(isHlsUrl("https://media.example/archive/video.mp4?next=.m3u8")).toBe(false);
  });

  it("forces autoplaying video to be muted", () => {
    expect(effectivePlaybackOptions(true, false)).toEqual({ autoplay: true, muted: true });
    expect(effectivePlaybackOptions(false, false)).toEqual({ autoplay: false, muted: false });
  });

  it("keeps authored-muted video silent in every playback mode", () => {
    // 静音态确定性行为:作者要求静音时,无论是否自动播放都全程静音且不解锁。
    expect(audioTrackPlan(true, true)).toEqual({ startMuted: true, soundOnUserGesture: false });
    expect(audioTrackPlan(true, false)).toEqual({ startMuted: true, soundOnUserGesture: false });
  });

  it("plans sound recovery through a user gesture only when autoplay was muted", () => {
    // 自动播放先静音规避策略,用户手势内恢复作者的有声意愿。
    expect(audioTrackPlan(false, true)).toEqual({ startMuted: true, soundOnUserGesture: true });
    // 非自动播放由用户在控制条内触发(自带手势),直接有声起播。
    expect(audioTrackPlan(false, false)).toEqual({ startMuted: false, soundOnUserGesture: false });
  });

  it("applies audio state deterministically with volume clamped to [0,1]", () => {
    const video = { muted: false, volume: 0.5 };
    applyVideoAudioState(video, true, 0.25);
    expect(video).toEqual({ muted: true, volume: 0.25 });
    // 越界与非有限音量都收敛到确定值,不把坏数据传进媒体元素。
    applyVideoAudioState(video, false, 1.5);
    expect(video.volume).toBe(1);
    applyVideoAudioState(video, false, -2);
    expect(video.volume).toBe(0);
    applyVideoAudioState(video, false, Number.NaN);
    expect(video.volume).toBe(1);
    applyVideoAudioState(video, false, Number.POSITIVE_INFINITY);
    expect(video.volume).toBe(1);
  });

  it("starts once media metadata is ready and avoids concurrent play requests", () => {
    expect(shouldRequestAutoplay(true, true, 0, false)).toBe(false);
    expect(shouldRequestAutoplay(true, true, 1, false)).toBe(true);
    expect(shouldRequestAutoplay(true, true, 4, true)).toBe(false);
    expect(shouldRequestAutoplay(true, false, 4, false)).toBe(false);
  });

  it("reports a visible waiting stream after 12 seconds and clears when time advances", () => {
    vi.useFakeTimers();
    let state = initialPlaybackWatchdogState(Date.now(), 45.93);
    let currentTime = 45.93;
    const timer = setInterval(() => {
      state = advancePlaybackWatchdog(state, { currentTime, paused: false, waiting: true, hidden: false }, Date.now());
    }, 1_000);

    vi.advanceTimersByTime(11_000);
    expect(state.stalled).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(state.stalled).toBe(true);
    currentTime = 46.2;
    vi.advanceTimersByTime(1_000);
    expect(state.stalled).toBe(false);

    clearInterval(timer);
    vi.useRealTimers();
  });

  it("does not report a stall while the page is hidden", () => {
    const initial = initialPlaybackWatchdogState(0, 10);
    expect(advancePlaybackWatchdog({ ...initial, waitingSince: 1_000 }, { currentTime: 10, paused: false, waiting: true, hidden: true }, 30_000).stalled).toBe(false);
  });

  it("caps automatic reconnect backoff at eight seconds", () => {
    expect([0, 1, 2, 3, 4, 8].map((attempt) => mediaReconnectDelay(attempt))).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  });

  it("treats a frozen HAVE_CURRENT_DATA frame as waiting even without a DOM event", () => {
    expect(isPlaybackWaiting(false, 2)).toBe(true);
    expect(isPlaybackWaiting(false, 3)).toBe(false);
    expect(isPlaybackWaiting(true, 4)).toBe(true);
  });
});
