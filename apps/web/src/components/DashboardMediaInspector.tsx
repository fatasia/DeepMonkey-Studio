import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, LoaderCircle, RadioTower } from "lucide-react";
import type { DashboardDataWidgetConfig, ProjectAssetRecord } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { liveSourceUrl, mediaUrlErrorMessage } from "./dashboardMedia";

export function DashboardMediaInspector({
  locale,
  projectId,
  widget,
  onChange,
}: {
  locale: AppLocale;
  projectId: string;
  widget: DashboardDataWidgetConfig;
  onChange: (patch: Partial<DashboardDataWidgetConfig>) => void;
}) {
  const [assets, setAssets] = useState<ProjectAssetRecord[]>([]);
  const [assetError, setAssetError] = useState(false);
  const [sourceDraft, setSourceDraft] = useState(widget.monitorSourceUrl ?? "");
  const [resolving, setResolving] = useState(false);
  const [resolveStatus, setResolveStatus] = useState<{ kind: "success" | "error"; text: string }>();
  const assetKind = widget.type === "image" ? "image" : widget.type === "video" ? "video" : undefined;
  const matchingAssets = useMemo(() => assets.filter((asset) => asset.kind === assetKind), [assetKind, assets]);

  useEffect(() => {
    if (!assetKind) return;
    let cancelled = false;
    setAssetError(false);
    void import("../api")
      .then(({ api }) => api.listAssets(projectId))
      .then((records) => {
        if (!cancelled) setAssets(records);
      })
      .catch(() => {
        if (!cancelled) setAssetError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [assetKind, projectId]);

  useEffect(() => {
    setSourceDraft(widget.monitorSourceUrl ?? "");
    setResolveStatus(undefined);
  }, [widget.monitorSourceUrl, widget.type]);

  if (widget.type === "image")
    return (
      <>
        <AssetSelector
          locale={locale}
          assets={matchingAssets}
          value={widget.assetId}
          emptyLabel={tr(locale, "选择图片资源", "Choose an image asset")}
          onSelect={(asset) => onChange({ assetId: asset.id, imageUrl: asset.url })}
        />
        {assetError && (
          <small className="dashboard-inspector-hint">
            {tr(locale, "资源读取失败，仍可使用安全的 HTTP(S) 地址。", "The assets could not be loaded; you can still use a safe HTTP(S) URL.")}
          </small>
        )}
        <label>
          <span>{tr(locale, "图片地址", "Image URL")}</span>
          <input
            key={widget.imageUrl}
            defaultValue={widget.imageUrl ?? ""}
            onBlur={(event) => onChange({ imageUrl: event.currentTarget.value })}
            placeholder="/assets/... or https://..."
          />
        </label>
        <label>
          <span>{tr(locale, "填充方式", "Fit")}</span>
          <select value={widget.imageFit ?? "cover"} onChange={(event) => onChange({ imageFit: event.target.value as NonNullable<DashboardDataWidgetConfig["imageFit"]> })}>
            <option value="cover">Cover</option>
            <option value="contain">Contain</option>
            <option value="fill">Fill</option>
          </select>
        </label>
      </>
    );

  if (widget.type === "video")
    return (
      <>
        <AssetSelector
          locale={locale}
          assets={matchingAssets}
          value={widget.assetId}
          emptyLabel={tr(locale, "选择视频资源", "Choose a video asset")}
          onSelect={(asset) => onChange({ assetId: asset.id, videoUrl: asset.url })}
        />
        {assetError && (
          <small className="dashboard-inspector-hint">
            {tr(locale, "资源读取失败，仍可填写 MP4、WebM 或 HLS 地址。", "The assets could not be loaded; you can still enter an MP4, WebM, or HLS URL.")}
          </small>
        )}
        <label>
          <span>{tr(locale, "视频地址", "Video URL")}</span>
          <input
            key={widget.videoUrl}
            defaultValue={widget.videoUrl ?? ""}
            onBlur={(event) => onChange({ videoUrl: event.currentTarget.value })}
            placeholder="/assets/... or https://..."
          />
        </label>
        <PlaybackOptions locale={locale} widget={widget} onChange={onChange} />
      </>
    );

  if (widget.type !== "monitor") return null;

  async function resolveMonitor() {
    const source = liveSourceUrl(sourceDraft);
    if (!source.ok) {
      setResolveStatus({ kind: "error", text: mediaUrlErrorMessage(source.reason, locale) });
      return;
    }
    setResolving(true);
    setResolveStatus(undefined);
    try {
      const protocol = widget.monitorProtocol ?? "hls";
      const { api } = await import("../api");
      const resolved = await api.resolveLiveMonitor(source.url, protocol);
      onChange({ monitorSourceUrl: source.url, videoUrl: protocol === "webrtc" ? resolved.webRtcUrl : resolved.hlsUrl });
      setResolveStatus({
        kind: "success",
        text: tr(locale, "媒体网关已连接，播放地址已写入组件。", "The media gateway is connected and the playback URL was saved to the widget."),
      });
    } catch (error) {
      setResolveStatus({ kind: "error", text: error instanceof Error ? error.message : tr(locale, "媒体网关连接失败", "Media gateway connection failed") });
    } finally {
      setResolving(false);
    }
  }

  return (
    <>
      <label>
        <span>{tr(locale, "监控源地址", "Monitor source URL")}</span>
        <input
          value={sourceDraft}
          onChange={(event) => setSourceDraft(event.target.value)}
          onBlur={() => onChange({ monitorSourceUrl: sourceDraft })}
          placeholder="rtsp:// · rtmp:// · srt:// · https://...m3u8"
        />
      </label>
      <label>
        <span>{tr(locale, "播放协议", "Playback protocol")}</span>
        <select
          value={widget.monitorProtocol ?? "hls"}
          onChange={(event) => {
            onChange({ monitorProtocol: event.target.value as "hls" | "webrtc", videoUrl: "" });
            setResolveStatus(undefined);
          }}
        >
          <option value="hls">HLS · {tr(locale, "兼容优先", "Compatibility")}</option>
          <option value="webrtc">WebRTC · {tr(locale, "低延迟", "Low latency")}</option>
        </select>
      </label>
      <button type="button" disabled={resolving || !sourceDraft.trim()} onClick={() => void resolveMonitor()}>
        {resolving ? <LoaderCircle className="spin" size={13} /> : <RadioTower size={13} />}
        {resolving ? tr(locale, "正在连接…", "Connecting…") : tr(locale, "解析并应用", "Resolve and apply")}
      </button>
      {resolveStatus && (
        <small className="dashboard-inspector-hint">
          {resolveStatus.kind === "success" ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
          {resolveStatus.text}
        </small>
      )}
      <label>
        <span>{tr(locale, "浏览器播放地址", "Browser playback URL")}</span>
        <input
          key={widget.videoUrl}
          defaultValue={widget.videoUrl ?? ""}
          onBlur={(event) => onChange({ videoUrl: event.currentTarget.value })}
          placeholder={tr(locale, "由媒体网关生成，也可填写现有 HLS/WebRTC 页面", "Generated by the gateway, or enter an existing HLS/WebRTC page")}
        />
      </label>
      <small className="dashboard-inspector-hint">
        {tr(
          locale,
          "监控播放独立于视觉 AI 任务；两者可使用同一源地址。跨域流需在媒体网关启用 CORS。",
          "Monitor playback is independent of Vision AI tasks; both can share the same source URL. Cross-origin streams require CORS on the media gateway.",
        )}
      </small>
      <PlaybackOptions locale={locale} widget={widget} onChange={onChange} />
    </>
  );
}

function AssetSelector({
  locale,
  assets,
  value,
  emptyLabel,
  onSelect,
}: {
  locale: AppLocale;
  assets: ProjectAssetRecord[];
  value: string | undefined;
  emptyLabel: string;
  onSelect: (asset: ProjectAssetRecord) => void;
}) {
  return (
    <label>
      <span>{tr(locale, "项目资源", "Project asset")}</span>
      <select
        value={value ?? ""}
        onChange={(event) => {
          const asset = assets.find((item) => item.id === event.target.value);
          if (asset) onSelect(asset);
        }}
      >
        <option value="">{emptyLabel}</option>
        {assets.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function PlaybackOptions({ locale, widget, onChange }: { locale: AppLocale; widget: DashboardDataWidgetConfig; onChange: (patch: Partial<DashboardDataWidgetConfig>) => void }) {
  const autoplay = widget.videoAutoplay !== false;
  return (
    <>
      <label>
        <span>{tr(locale, "填充方式", "Fit")}</span>
        <select value={widget.videoFit ?? "contain"} onChange={(event) => onChange({ videoFit: event.target.value as NonNullable<DashboardDataWidgetConfig["videoFit"]> })}>
          <option value="cover">Cover</option>
          <option value="contain">Contain</option>
          <option value="fill">Fill</option>
        </select>
      </label>
      <label>
        <span>{tr(locale, "自动播放", "Autoplay")}</span>
        <input type="checkbox" checked={autoplay} onChange={(event) => onChange({ videoAutoplay: event.target.checked, ...(event.target.checked ? { videoMuted: true } : {}) })} />
      </label>
      <label>
        <span>{tr(locale, "静音", "Muted")}</span>
        <input type="checkbox" checked={autoplay || widget.videoMuted !== false} disabled={autoplay} onChange={(event) => onChange({ videoMuted: event.target.checked })} />
      </label>
      <label>
        <span>{tr(locale, "播放方式", "Playback")}</span>
        <select value={widget.videoLoop === false ? "once" : "loop"} onChange={(event) => onChange({ videoLoop: event.target.value === "loop" })}>
          <option value="once">{tr(locale, "播放一次", "Play once")}</option>
          <option value="loop">{tr(locale, "循环播放", "Loop")}</option>
        </select>
      </label>
      {autoplay && <small className="dashboard-inspector-hint">{tr(locale, "浏览器要求自动播放必须静音。", "Browsers require autoplaying media to be muted.")}</small>}
    </>
  );
}
