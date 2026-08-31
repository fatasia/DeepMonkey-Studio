import { X } from "lucide-react";
import type { VisionSourceRecord } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { browserMediaUrl, mediaUrlErrorMessage } from "./dashboardMedia";
import { StreamVideo } from "./DashboardMediaPlayer";

export function VisionSourcePreview({ source, locale, onClose }: { source: VisionSourceRecord; locale: AppLocale; onClose: () => void }) {
  const playback = browserMediaUrl(source.playbackUrl, typeof window === "undefined" ? undefined : window.location.protocol);
  return (
    <section className="vision-source-preview" style={{ margin: "0 13px 13px", overflow: "hidden", border: "1px solid #2a383e", borderRadius: 8, background: "#0d1519" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderBottom: "1px solid #253238" }}>
        <div style={{ display: "grid", gap: 2 }}>
          <strong>{source.name}</strong>
          <small>{source.protocol?.toUpperCase() ?? source.kind.toUpperCase()} · {source.playbackProtocol?.toUpperCase() ?? tr(locale, "直接播放", "direct playback")}</small>
        </div>
        <button type="button" onClick={onClose} aria-label={tr(locale, "关闭预览", "Close preview")}><X size={14} /></button>
      </header>
      <div style={{ position: "relative", display: "grid", minHeight: 280, maxHeight: 520, placeItems: "center", background: "#05090b" }}>
        {!playback.ok ? (
          <span>{mediaUrlErrorMessage(playback.reason, locale)}</span>
        ) : source.kind === "image" ? (
          <img src={playback.url} alt={source.name} style={{ width: "100%", maxHeight: 520, objectFit: "contain" }} />
        ) : source.playbackProtocol === "webrtc" ? (
          <iframe
            src={playback.url}
            title={source.name}
            allow="autoplay; fullscreen"
            sandbox="allow-scripts allow-same-origin allow-forms"
            referrerPolicy="no-referrer"
            style={{ width: "100%", height: 420, border: 0 }}
          />
        ) : (
          <StreamVideo src={playback.url} fit="contain" autoplay={false} muted loop={source.protocol === "upload"} controls locale={locale} />
        )}
      </div>
    </section>
  );
}
