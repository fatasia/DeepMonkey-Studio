import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CloudCog, ExternalLink, LoaderCircle, Play, RefreshCw, ServerOff, Square, Video } from "lucide-react";
import type { CloudRenderControlOverview, CloudRenderSceneControl } from "@bim-studio/server-sdk";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import "./CloudRenderControl.css";

type Translate = (zh: string, en: string) => string;

export function CloudRenderControl({ locale }: { locale: AppLocale }) {
  const t: Translate = (zh, en) => tr(locale, zh, en);
  const [overview, setOverview] = useState<CloudRenderControlOverview>();
  const [busySceneId, setBusySceneId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  async function load() {
    setLoading(true);
    try { setOverview(await api.getCloudRenderOverview()); setError(undefined); }
    catch (reason) { setError(message(reason)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function run(sceneId: string, action: () => Promise<unknown>) {
    setBusySceneId(sceneId);
    setError(undefined);
    try { await action(); }
    catch (reason) { setError(message(reason)); }
    finally {
      setBusySceneId(undefined);
      await load();
    }
  }

  async function enableAndStart(sceneId: string) {
    await api.setCloudRenderEnabled(sceneId, true);
    await api.startCloudRenderSession(sceneId);
  }

  if (loading && !overview) return <div className="cloud-render-loading"><LoaderCircle className="spin" /><span>{t("正在检查 GPU Worker 与媒体证据", "Checking GPU Worker and media evidence")}</span></div>;
  if (!overview) return <div className="cloud-render-empty"><ServerOff /><strong>{t("无法读取云渲染控制面", "Cloud rendering control plane unavailable")}</strong>{error && <span>{error}</span>}<button onClick={() => void load()}>{t("重试", "Retry")}</button></div>;

  return <CloudRenderControlView
    t={t}
    overview={overview}
    {...(busySceneId ? { busySceneId } : {})}
    {...(error ? { error } : {})}
    onReload={() => void load()}
    onEnableAndStart={(sceneId) => void run(sceneId, () => enableAndStart(sceneId))}
    onStart={(sceneId) => void run(sceneId, () => api.startCloudRenderSession(sceneId))}
    onRefresh={(sceneId) => void run(sceneId, () => api.refreshCloudRenderSession(sceneId))}
    onStop={(sceneId) => void run(sceneId, () => api.stopCloudRenderSession(sceneId))}
    onDisable={(sceneId) => void run(sceneId, () => api.setCloudRenderEnabled(sceneId, false))}
  />;
}

export function CloudRenderControlView({ t, overview, busySceneId, error, onReload, onEnableAndStart, onStart, onRefresh, onStop, onDisable }: {
  t: Translate;
  overview: CloudRenderControlOverview;
  busySceneId?: string;
  error?: string;
  onReload: () => void;
  onEnableAndStart: (sceneId: string) => void;
  onStart: (sceneId: string) => void;
  onRefresh: (sceneId: string) => void;
  onStop: (sceneId: string) => void;
  onDisable: (sceneId: string) => void;
}) {
  const workerReady = overview.worker?.status === "ready";
  return <div className="cloud-render-control">
    <header className="cloud-render-heading">
      <div><span className={workerReady ? "ready" : "unavailable"}>{workerReady ? <CheckCircle2 /> : <ServerOff />}</span><div><strong>{t("真实云渲染控制面", "Real cloud rendering control plane")}</strong><small>{t("场景、GPU 容量、编码器与 WebRTC 媒体证据全部通过后才显示运行中", "Running only after scene, GPU, encoder and WebRTC media evidence are verified")}</small></div></div>
      <button disabled={Boolean(busySceneId)} onClick={onReload}><RefreshCw size={15} />{t("刷新证据", "Refresh evidence")}</button>
    </header>
    {error && <div className="cloud-render-error"><AlertTriangle size={16} /><span>{error}</span></div>}
    {!overview.configured && <section className="cloud-render-requirements"><ServerOff /><div><strong>{t("真实 GPU Worker 尚未接入", "Real GPU Worker is not connected")}</strong><p>{t("控制面不会使用计时器或假状态冒充媒体可用。请配置以下服务器环境变量：", "The control plane never uses timers or fake states as media readiness. Configure:")}</p><code>{overview.missingRequirements.join(" · ")}</code></div></section>}
    {overview.workerError && <section className="cloud-render-requirements warning"><AlertTriangle /><div><strong>{t("Worker 证据不可用", "Worker evidence unavailable")}</strong><p>{overview.workerError}</p></div></section>}
    {overview.worker && <section className="cloud-render-worker">
      <article><span>{t("Worker", "Worker")}</span><strong>{overview.worker.workerId}</strong><small>{new Date(overview.worker.observedAt).toLocaleString()}</small></article>
      <article><span>GPU</span><strong>{overview.worker.gpu.vendor} {overview.worker.gpu.model}</strong><small>{overview.worker.gpu.memoryMiB > 0 ? `${Math.round(overview.worker.gpu.memoryMiB / 1024)} GB · ` : ""}{overview.worker.gpu.encoder.codecs.join(" / ").toUpperCase()}</small></article>
      <article><span>{t("容量", "Capacity")}</span><strong>{overview.worker.capacity.activeSessions} / {overview.worker.capacity.maxSessions}</strong><small>{overview.worker.gpu.encoder.hardware ? encoderEvidenceLabel(t, overview.worker.gpu.encoder.evidenceSource) : t("没有硬件编码", "No hardware encoder")}</small></article>
    </section>}
    <div className="cloud-render-scenes">
      {overview.scenes.map((scene) => <CloudRenderSceneCard
        key={scene.sceneId}
        t={t}
        scene={scene}
        configured={overview.configured}
        busy={busySceneId === scene.sceneId}
        onEnableAndStart={() => onEnableAndStart(scene.sceneId)}
        onStart={() => onStart(scene.sceneId)}
        onRefresh={() => onRefresh(scene.sceneId)}
        onStop={() => onStop(scene.sceneId)}
        onDisable={() => onDisable(scene.sceneId)}
      />)}
      {overview.scenes.length === 0 && <div className="cloud-render-empty"><Video /><strong>{t("没有已发布场景", "No published scenes")}</strong><span>{t("先在场景管理中发布一个场景，再为该发布快照开启云渲染。", "Publish a scene first, then enable cloud rendering for that published snapshot.")}</span></div>}
    </div>
  </div>;
}

function CloudRenderSceneCard({ t, scene, configured, busy, onEnableAndStart, onStart, onRefresh, onStop, onDisable }: {
  t: Translate;
  scene: CloudRenderSceneControl;
  configured: boolean;
  busy: boolean;
  onEnableAndStart: () => void;
  onStart: () => void;
  onRefresh: () => void;
  onStop: () => void;
  onDisable: () => void;
}) {
  const session = scene.session;
  const mediaReady = session?.state === "streaming" || session?.state === "degraded";
  const active = Boolean(session && !["closed", "failed"].includes(session.state));
  return <article className={`cloud-render-scene ${mediaReady ? "media-ready" : ""}`}>
    <header><div><CloudCog /><span><strong>{scene.name}</strong><small>{scene.sceneId} · {new Date(scene.publishedAt).toLocaleString()}</small></span></div><i className={mediaReady ? "ready" : session?.state ?? "disabled"}>{statusLabel(t, scene)}</i></header>
    {scene.publicationChanged && <div className="cloud-render-warning"><AlertTriangle size={14} />{t("场景已重新发布，必须停止旧 Worker 会话后重建", "Scene was republished; stop the old Worker session before rebuilding")}</div>}
    <dl>
      <div><dt>{t("发布作用域", "Published scope")}</dt><dd>{scene.projectId} / {scene.sceneId}</dd></div>
      <div><dt>{t("管理策略", "Admin policy")}</dt><dd>{scene.enabled ? t("允许创建会话", "Sessions allowed") : t("已关闭", "Disabled")}</dd></div>
      <div><dt>{t("控制状态", "Control state")}</dt><dd>{session?.state ?? "idle"}{session?.failureCode ? ` · ${session.failureCode}` : ""}</dd></div>
    </dl>
    {session?.mediaEvidence && <section className="cloud-render-evidence"><div><CheckCircle2 /><span><strong>{t("媒体已验证", "Media verified")}</strong><small>WebRTC outbound-rtp · {new Date(session.mediaEvidence.observedAt).toLocaleString()}</small></span></div><dl><div><dt>{t("编码", "Codec")}</dt><dd>{session.mediaEvidence.codec.toUpperCase()} · {session.mediaEvidence.width}×{session.mediaEvidence.height}</dd></div><div><dt>{t("硬件证据", "Hardware proof")}</dt><dd>{session.mediaEvidence.encoderEvidence} · {session.mediaEvidence.encoderImplementation}</dd></div><div><dt>{t("计数", "Counters")}</dt><dd>{session.mediaEvidence.framesEncoded} frames · {session.mediaEvidence.packetsSent} packets · {formatBytes(session.mediaEvidence.bytesSent)}</dd></div></dl></section>}
    {session?.viewerUrl && !["closed", "failed", "closing"].includes(session.state) && <a className="cloud-render-viewer" href={session.viewerUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />{mediaReady ? t("打开 Worker 观看端", "Open Worker viewer") : t("打开观看端并建立媒体", "Open viewer to establish media")}</a>}
    <footer>
      {!scene.enabled && (!session || session.state === "closed") && <button className="primary" disabled={busy || !configured} onClick={onEnableAndStart}>{busy ? <LoaderCircle className="spin" /> : <Play />}{t("启用并启动", "Enable & start")}</button>}
      {scene.enabled && (!session || session.state === "closed") && <button className="primary" disabled={busy || !configured} onClick={onStart}>{busy ? <LoaderCircle className="spin" /> : <Play />}{t("创建会话", "Start session")}</button>}
      {session && active && <><button disabled={busy} onClick={onRefresh}><RefreshCw />{t("验证媒体", "Verify media")}</button><button className="danger" disabled={busy} onClick={onDisable}><Square />{t("停止并关闭", "Stop & disable")}</button></>}
      {session?.state === "failed" && <><button disabled={busy || !session.workerSessionId} onClick={onStop}><Square />{t("重试停止 Worker", "Retry Worker stop")}</button><button className="danger" disabled={busy || !session.workerSessionId} onClick={onDisable}>{t("停止并关闭", "Stop & disable")}</button></>}
    </footer>
  </article>;
}

export function statusLabel(t: Translate, scene: CloudRenderSceneControl): string {
  if (scene.publicationChanged) return t("发布已变化", "Publication changed");
  const state = scene.session?.state;
  if (state === "streaming") return t("媒体运行中", "Media streaming");
  if (state === "degraded") return t("媒体降级", "Media degraded");
  if (state === "signaling" || state === "allocating") return t("等待媒体证据", "Awaiting media proof");
  if (state === "closing") return t("正在停止", "Stopping");
  if (state === "failed") return t("失败，未确认关闭", "Failed; stop unconfirmed");
  return scene.enabled ? t("已启用，未启动", "Enabled; not started") : t("已关闭", "Disabled");
}

function formatBytes(value: number): string {
  return value >= 1_048_576 ? `${(value / 1_048_576).toFixed(1)} MiB` : `${Math.round(value / 1024)} KiB`;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function encoderEvidenceLabel(t: Translate, source: "runtime-loopback" | "operator-attested" | "none" | undefined): string {
  if (source === "runtime-loopback") return t("真实 WebRTC 回环已验证", "Verified by real WebRTC loopback");
  if (source === "operator-attested") return t("运维确认的硬件编码", "Operator-attested hardware encoder");
  return t("硬件编码可用，证据源未声明", "Hardware encoder ready; source unspecified");
}
