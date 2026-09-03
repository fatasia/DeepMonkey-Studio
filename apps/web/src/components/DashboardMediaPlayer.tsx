import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Cctv, Image as ImageIcon, RefreshCw, Video } from "lucide-react";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import {
  advancePlaybackWatchdog,
  browserMediaUrl,
  effectivePlaybackOptions,
  initialPlaybackWatchdogState,
  isHlsUrl,
  isPlaybackWaiting,
  liveSourceUrl,
  mediaReconnectDelay,
  mediaReferenceFromWidget,
  mediaUrlErrorMessage,
  shouldRequestAutoplay,
} from "./dashboardMedia";

interface StreamVideoProps {
  src: string;
  fit: "cover" | "contain" | "fill";
  autoplay: boolean;
  muted: boolean;
  loop: boolean;
  controls: boolean;
  locale: AppLocale;
}

export function DashboardImage({ widget, locale }: { widget: DashboardDataWidgetConfig; locale: AppLocale }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const reference = mediaReferenceFromWidget(widget);
  const result = browserMediaUrl(reference?.playbackUrl, pageProtocol());
  useEffect(() => setFailed(false), [reference?.playbackUrl]);
  if (!result.ok) return <MediaMessage locale={locale} icon="image" message={mediaUrlErrorMessage(result.reason, locale)} />;
  if (failed)
    return (
      <MediaMessage
        locale={locale}
        icon="image"
        message={tr(locale, "图片加载失败，请检查地址、权限或 CORS。", "Image loading failed. Check the URL, permissions, or CORS.")}
        onRetry={() => {
          setFailed(false);
          setAttempt((value) => value + 1);
        }}
      />
    );
  return <img key={attempt} src={result.url} alt={widget.title} style={{ objectFit: widget.imageFit ?? "cover" }} onError={() => setFailed(true)} />;
}

export function DashboardVideo({ widget, locale, compact }: { widget: DashboardDataWidgetConfig; locale: AppLocale; compact: boolean }) {
  const reference = mediaReferenceFromWidget(widget);
  return reference?.playbackUrl ? (
    <StreamVideo
      src={reference.playbackUrl}
      fit={widget.videoFit ?? "contain"}
      autoplay={widget.videoAutoplay !== false && !compact}
      muted={widget.videoMuted !== false}
      loop={widget.videoLoop !== false}
      controls={!compact}
      locale={locale}
    />
  ) : (
    <MediaMessage locale={locale} icon="video" message={tr(locale, "从资源选择视频或填写 HTTP(S) 地址", "Choose a video asset or enter an HTTP(S) URL")} />
  );
}

export function DashboardMonitor({ widget, locale, compact }: { widget: DashboardDataWidgetConfig; locale: AppLocale; compact: boolean }) {
  const reference = mediaReferenceFromWidget(widget);
  const [resolvedUrl, setResolvedUrl] = useState(reference?.playbackUrl);
  const [failure, setFailure] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setFailure(undefined);
    setResolvedUrl(reference?.playbackUrl);
    if (reference?.playbackUrl || !reference?.sourceUrl) return;
    const source = liveSourceUrl(reference.sourceUrl);
    if (!source.ok) {
      setFailure(mediaUrlErrorMessage(source.reason, locale));
      return;
    }
    let cancelled = false;
    void import("../api")
      .then(({ api }) => api.resolveLiveMonitor(source.url, reference.protocol ?? "hls"))
      .then((resolved) => {
        if (!cancelled) setResolvedUrl(reference.protocol === "webrtc" ? resolved.webRtcUrl : resolved.hlsUrl);
      })
      .catch((error) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : tr(locale, "监控流解析失败", "Monitor stream resolution failed"));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, locale, reference?.playbackUrl, reference?.protocol, reference?.sourceUrl]);

  if (failure) return <MediaMessage locale={locale} icon="monitor" message={failure} onRetry={() => setAttempt((value) => value + 1)} />;
  if (!resolvedUrl)
    return (
      <MediaMessage
        locale={locale}
        icon="monitor"
        message={
          reference?.sourceUrl ? tr(locale, "正在连接媒体网关…", "Connecting to the media gateway…") : tr(locale, "填写监控源地址并解析", "Enter and resolve a monitor source URL")
        }
      />
    );
  if (reference?.protocol === "webrtc") {
    const result = browserMediaUrl(resolvedUrl, pageProtocol());
    if (!result.ok) return <MediaMessage locale={locale} icon="monitor" message={mediaUrlErrorMessage(result.reason, locale)} onRetry={() => setAttempt((value) => value + 1)} />;
    return (
      <>
        <iframe src={result.url} title={widget.title} allow="autoplay; fullscreen" sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" />
        {compact && <i>{tr(locale, "编辑时已暂停画面交互", "Interaction paused while editing")}</i>}
      </>
    );
  }
  return (
    <StreamVideo
      src={resolvedUrl}
      fit={widget.videoFit ?? "cover"}
      autoplay={widget.videoAutoplay !== false && !compact}
      muted={widget.videoMuted !== false}
      loop={widget.videoLoop !== false}
      controls={!compact}
      locale={locale}
    />
  );
}

export function StreamVideo({ src, fit, autoplay, muted, loop, controls, locale }: StreamVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failure, setFailure] = useState<{ kind: "stream" | "autoplay"; text: string }>();
  const [stalled, setStalled] = useState(false);
  const [reconnectNotice, setReconnectNotice] = useState<number>();
  const [attempt, setAttempt] = useState(0);
  const reconnectAttemptRef = useRef(0);
  const safe = browserMediaUrl(src, pageProtocol());
  const playback = effectivePlaybackOptions(autoplay, muted);

  function retryPlayback() {
    const video = ref.current;
    if (failure?.kind === "autoplay" && video) {
      video.muted = true;
      void video
        .play()
        .then(() => setFailure(undefined))
        .catch(() => setAttempt((value) => value + 1));
      return;
    }
    setFailure(undefined);
    setStalled(false);
    setAttempt((value) => value + 1);
  }

  useEffect(() => {
    const video = ref.current;
    if (!video || !safe.ok) return;
    setFailure(undefined);
    setStalled(false);
    let disposed = false;
    let retryTimer: number | undefined;
    let watchdogTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let player: { destroy: () => void } | undefined;
    let playRequestPending = false;
    let waiting = false;
    let watchdog = initialPlaybackWatchdogState(Date.now(), video.currentTime);
    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== undefined || !playback.autoplay || document.hidden) return;
      const reconnectNumber = reconnectAttemptRef.current + 1;
      reconnectAttemptRef.current = reconnectNumber;
      setReconnectNotice(reconnectNumber);
      const delay = mediaReconnectDelay(reconnectNumber - 1);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        if (!disposed) setAttempt((value) => value + 1);
      }, delay);
    };
    const inspectPlayback = () => {
      const wasStalled = watchdog.stalled;
      watchdog = advancePlaybackWatchdog(
        watchdog,
        { currentTime: video.currentTime, paused: video.paused, waiting: isPlaybackWaiting(waiting, video.readyState), hidden: document.hidden },
        Date.now(),
      );
      if (!disposed) setStalled(watchdog.stalled);
      if (!wasStalled && watchdog.stalled) scheduleReconnect();
    };
    const markWaiting = () => {
      waiting = true;
      inspectPlayback();
    };
    const markPlaying = () => {
      waiting = false;
      inspectPlayback();
    };
    const markProgress = () => {
      const previousTime = watchdog.lastCurrentTime;
      waiting = false;
      inspectPlayback();
      if (Math.abs(video.currentTime - previousTime) >= 0.05) {
        reconnectAttemptRef.current = 0;
        setReconnectNotice(undefined);
      }
    };
    const fail = () => {
      if (!disposed) {
        setStalled(false);
        setFailure({
          kind: "stream",
          text: tr(
            locale,
            "播放失败或流已中断。请检查流服务、鉴权、CORS 后重试。",
            "Playback failed or the stream was interrupted. Check the service, authentication, and CORS, then retry.",
          ),
        });
        scheduleReconnect();
      }
    };
    const beginPlayback = () => {
      if (!shouldRequestAutoplay(playback.autoplay, video.paused, video.readyState, playRequestPending) || disposed) return;
      playRequestPending = true;
      video.muted = true;
      video.defaultMuted = true;
      void video
        .play()
        .then(() => {
          if (!disposed) setFailure(undefined);
        })
        .catch(() => {
          if (!disposed)
            setFailure({
              kind: "autoplay",
              text: tr(locale, "画面已就绪，浏览器需要一次点击才能开始播放。", "The stream is ready; the browser requires one click to start playback."),
            });
        })
        .finally(() => {
          playRequestPending = false;
        });
    };
    const clearFailure = () => {
      if (!disposed) setFailure(undefined);
    };
    const mediaReady = () => {
      if (disposed) return;
      clearFailure();
      setStalled(false);
      beginPlayback();
    };

    if (isHlsUrl(safe.url)) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = safe.url;
        video.addEventListener("loadedmetadata", mediaReady);
      } else {
        void import("hls.js")
          .then(({ default: Hls }) => {
            if (disposed) return;
            if (!Hls.isSupported()) {
              fail();
              return;
            }
            const hls = new Hls({ lowLatencyMode: true, backBufferLength: 30, maxBufferLength: 12 });
            player = hls;
            let networkRetries = 0;
            let mediaRecoveries = 0;
            hls.on(Hls.Events.MEDIA_ATTACHED, mediaReady);
            hls.on(Hls.Events.MANIFEST_PARSED, mediaReady);
            hls.on(Hls.Events.ERROR, (_event, data) => {
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) markWaiting();
              if (!data.fatal || disposed) return;
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
                networkRetries += 1;
                retryTimer = window.setTimeout(() => hls.startLoad(), networkRetries * 1_000);
                return;
              }
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 1) {
                mediaRecoveries += 1;
                hls.recoverMediaError();
                return;
              }
              fail();
            });
            hls.loadSource(safe.url);
            hls.attachMedia(video);
          })
          .catch(fail);
      }
    } else {
      video.src = safe.url;
      video.addEventListener("loadedmetadata", mediaReady);
    }
    video.addEventListener("loadeddata", mediaReady);
    video.addEventListener("canplay", mediaReady);
    video.addEventListener("playing", clearFailure);
    video.addEventListener("playing", markPlaying);
    video.addEventListener("timeupdate", markProgress);
    video.addEventListener("waiting", markWaiting);
    video.addEventListener("stalled", markWaiting);
    video.addEventListener("error", fail);
    watchdogTimer = window.setInterval(inspectPlayback, 1_000);
    beginPlayback();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (watchdogTimer !== undefined) window.clearInterval(watchdogTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      player?.destroy();
      video.removeEventListener("error", fail);
      video.removeEventListener("loadedmetadata", mediaReady);
      video.removeEventListener("loadeddata", mediaReady);
      video.removeEventListener("canplay", mediaReady);
      video.removeEventListener("playing", clearFailure);
      video.removeEventListener("playing", markPlaying);
      video.removeEventListener("timeupdate", markProgress);
      video.removeEventListener("waiting", markWaiting);
      video.removeEventListener("stalled", markWaiting);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [attempt, locale, playback.autoplay, safe.ok ? safe.url : ""]);

  if (!safe.ok) return <MediaMessage locale={locale} icon="video" message={mediaUrlErrorMessage(safe.reason, locale)} />;
  return (
    <>
      <video ref={ref} style={{ objectFit: fit }} autoPlay={playback.autoplay} muted={playback.muted} controls={controls} loop={loop} playsInline preload="metadata" />
      {failure && !reconnectNotice && (
        <MediaMessage locale={locale} icon={failure.kind === "stream" ? "warning" : "video"} message={failure.text} onRetry={retryPlayback} overlay={failure.kind === "stream"} />
      )}
      {reconnectNotice && (
        <MediaMessage
          locale={locale}
          icon="video"
          message={tr(locale, `信号中断，正在自动重连（第 ${reconnectNotice} 次）…`, `Signal interrupted. Reconnecting automatically (attempt ${reconnectNotice})…`)}
          overlay
        />
      )}
      {stalled && !failure && !reconnectNotice && (
        <MediaMessage locale={locale} icon="video" message={tr(locale, "信号中断，正在自动重连…", "Signal interrupted. Reconnecting automatically…")} overlay />
      )}
    </>
  );
}

function MediaMessage({
  locale,
  icon,
  message,
  onRetry,
  overlay = false,
}: {
  locale: AppLocale;
  icon: "image" | "video" | "monitor" | "warning";
  message: string;
  onRetry?: () => void;
  overlay?: boolean;
}) {
  const Icon = icon === "image" ? ImageIcon : icon === "video" ? Video : icon === "monitor" ? Cctv : AlertTriangle;
  return (
    <div
      role={icon === "warning" ? "alert" : "status"}
      style={overlay ? { position: "absolute", inset: 0, padding: 12, textAlign: "center", background: "rgba(7,11,13,.88)", zIndex: 2 } : undefined}
    >
      <Icon size={22} />
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          <RefreshCw size={12} />
          {tr(locale, "重试", "Retry")}
        </button>
      )}
    </div>
  );
}

function pageProtocol(): string | undefined {
  return typeof window === "undefined" ? undefined : window.location.protocol;
}
