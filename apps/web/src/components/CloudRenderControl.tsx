import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CloudCog,
  Copy,
  ExternalLink,
  LoaderCircle,
  Play,
  RefreshCw,
  ServerOff,
  Settings2,
  Square,
  Video,
} from "lucide-react";
import type {
  CloudRenderControlOverview,
  CloudRenderSceneControl,
} from "@bim-studio/server-sdk";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import "./CloudRenderControl.css";
import "./CloudRenderConfiguration.css";

type Translate = (zh: string, en: string) => string;

export function CloudRenderControl({ locale }: { locale: AppLocale }) {
  const t: Translate = (zh, en) => tr(locale, zh, en);
  const [overview, setOverview] = useState<CloudRenderControlOverview>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  async function load() {
    setLoading(true);
    try {
      setOverview(await api.getCloudRenderOverview());
      setError(undefined);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loading && !overview)
    return (
      <div className="cloud-render-loading">
        <LoaderCircle className="spin" />
        <span>
          {t("正在读取云渲染配置", "Loading cloud rendering configuration")}
        </span>
      </div>
    );
  if (!overview)
    return (
      <div className="cloud-render-empty">
        <ServerOff />
        <strong>
          {t("无法读取云渲染配置", "Cloud rendering configuration unavailable")}
        </strong>
        {error && <span>{error}</span>}
        <button onClick={() => void load()}>{t("重试", "Retry")}</button>
      </div>
    );

  return (
    <>
      <CloudRenderConfigurationWizard
        locale={locale}
        configured={overview.configured}
      />
      {error && (
        <div className="cloud-render-error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}
      <p className="cloud-render-config-scope">
        {t(
          "这里只配置 GPU Worker 和安全部署参数。场景是否使用云渲染，请在场景管理卡片中逐个开启。",
          "Configure the GPU Worker and secure deployment values here. Enable cloud rendering per scene from the scene manager cards.",
        )}
      </p>
    </>
  );
}

export function CloudRenderConfigurationWizard({
  locale,
  configured,
}: {
  locale: AppLocale;
  configured: boolean;
}) {
  const t: Translate = (zh, en) => tr(locale, zh, en);
  const [open, setOpen] = useState(!configured);
  const [workerUrl, setWorkerUrl] = useState("http://127.0.0.1:4200");
  const [workerToken, setWorkerToken] = useState("");
  const [publicOrigin, setPublicOrigin] = useState(defaultPublicOrigin);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  const environment = `CLOUD_RENDER_WORKER_URL=${workerUrl}\nCLOUD_RENDER_WORKER_TOKEN=<secure-token>\nCLOUD_RENDER_PUBLIC_ORIGIN=${publicOrigin}`;

  function useLocalDefaults() {
    setWorkerUrl("http://127.0.0.1:4200");
    setPublicOrigin(defaultPublicOrigin());
  }

  async function test() {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const response = await api.testCloudRenderConfiguration({
        workerUrl,
        workerToken,
        publicOrigin,
      });
      if (!response.ok) {
        setError(
          t(
            `Worker 已连通，但当前状态为 ${response.worker.status}，尚不能承载云渲染会话。`,
            `Worker is reachable but reports ${response.worker.status}; it cannot serve cloud-rendering sessions yet.`,
          ),
        );
        return;
      }
      setResult(
        t(
          `连接成功：${response.worker.gpu.vendor} ${response.worker.gpu.model} · ${response.worker.gpu.encoder.codecs.join("/").toUpperCase()} · 容量 ${response.worker.capacity.activeSessions}/${response.worker.capacity.maxSessions}`,
          `Connected: ${response.worker.gpu.vendor} ${response.worker.gpu.model} · ${response.worker.gpu.encoder.codecs.join("/").toUpperCase()} · capacity ${response.worker.capacity.activeSessions}/${response.worker.capacity.maxSessions}`,
        ),
      );
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`cloud-render-config ${open ? "open" : ""}`}>
      <header>
        <div>
          <Settings2 />
          <span>
            <strong>{t("云渲染设置", "Cloud rendering settings")}</strong>
            <small>
              {configured
                ? t(
                    "服务端配置已加载；这里用于检查 Worker 是否可用",
                    "Server configuration loaded; use this page to verify the Worker",
                  )
                : t(
                    "只需填写 Worker 地址和令牌，场景开关在场景管理中",
                    "Enter the Worker address and token; scene switches live in scene manager",
                  )}
            </small>
          </span>
        </div>
        <button onClick={() => setOpen((value) => !value)}>
          {open ? t("收起", "Collapse") : t("检查配置", "Check setup")}
        </button>
      </header>
      {open && (
        <div className="cloud-render-config-body">
          <div className="cloud-render-quick-head">
            <span>
              <b>1</b>
              {t("连接 GPU Worker", "Connect GPU Worker")}
            </span>
            <button onClick={useLocalDefaults}>
              {t("使用本机默认值", "Use local defaults")}
            </button>
          </div>
          <div className="cloud-render-config-fields">
            <label>
              <span>{t("Worker 地址", "Worker URL")}</span>
              <input
                value={workerUrl}
                onChange={(event) => setWorkerUrl(event.target.value)}
                placeholder="https://gpu-worker.example.com"
              />
            </label>
            <label>
              <span>{t("访问令牌", "Worker Token")}</span>
              <input
                type="password"
                value={workerToken}
                onChange={(event) => setWorkerToken(event.target.value)}
                autoComplete="new-password"
              />
              <small>
                {t(
                  "只用于本次服务端连接测试，不会保存到浏览器或项目",
                  "Used only for this server-side test; never stored in the browser or project",
                )}
              </small>
            </label>
          </div>
          <details className="cloud-render-config-advanced">
            <summary>
              {t("高级部署设置", "Advanced deployment settings")}
            </summary>
            <label>
              <span>Public Origin</span>
              <input
                value={publicOrigin}
                onChange={(event) => setPublicOrigin(event.target.value)}
                placeholder="https://studio.example.com"
              />
            </label>
            <div className="cloud-render-config-deploy">
              <span>{t("部署密钥模板", "Deployment secret template")}</span>
              <pre>{environment}</pre>
              <button
                onClick={() => void navigator.clipboard.writeText(environment)}
              >
                <Copy size={13} />
                {t("复制模板", "Copy template")}
              </button>
            </div>
          </details>
          {error && (
            <div className="cloud-render-config-message error">
              <AlertTriangle />
              {error}
            </div>
          )}
          {result && (
            <div className="cloud-render-config-message success">
              <CheckCircle2 />
              {result}
            </div>
          )}
          <footer>
            <span>
              <b>2</b>
              {t(
                "测试通过后由部署环境安全保存；场景内可直接一键开启。",
                "After validation, save securely in deployment; scenes can then be enabled with one click.",
              )}
            </span>
            <button
              className="primary"
              disabled={
                busy ||
                !workerUrl.trim() ||
                !workerToken.trim() ||
                !publicOrigin.trim()
              }
              onClick={() => void test()}
            >
              {busy ? <LoaderCircle className="spin" /> : <RefreshCw />}
              {t("测试连接", "Test connection")}
            </button>
          </footer>
        </div>
      )}
    </section>
  );
}

function defaultPublicOrigin(): string {
  if (typeof window === "undefined") return "http://127.0.0.1:4100";
  const url = new URL(window.location.origin);
  if (
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname) &&
    url.port !== "4100"
  )
    url.port = "4100";
  return url.origin;
}

export function CloudRenderControlView({
  t,
  overview,
  busySceneId,
  error,
  onReload,
  onEnableAndStart,
  onStart,
  onRefresh,
  onStop,
  onDisable,
}: {
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
  return (
    <div className="cloud-render-control">
      <header className="cloud-render-heading">
        <div>
          <span className={workerReady ? "ready" : "unavailable"}>
            {workerReady ? <CheckCircle2 /> : <ServerOff />}
          </span>
          <div>
            <strong>
              {t("真实云渲染控制面", "Real cloud rendering control plane")}
            </strong>
            <small>
              {t(
                "场景、GPU 容量、编码器与 WebRTC 媒体证据全部通过后才显示运行中",
                "Running only after scene, GPU, encoder and WebRTC media evidence are verified",
              )}
            </small>
          </div>
        </div>
        <button disabled={Boolean(busySceneId)} onClick={onReload}>
          <RefreshCw size={15} />
          {t("刷新证据", "Refresh evidence")}
        </button>
      </header>
      {error && (
        <div className="cloud-render-error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}
      {!overview.configured && (
        <section className="cloud-render-requirements">
          <ServerOff />
          <div>
            <strong>
              {t(
                "真实 GPU Worker 尚未接入",
                "Real GPU Worker is not connected",
              )}
            </strong>
            <p>
              {t(
                "控制面不会使用计时器或假状态冒充媒体可用。请配置以下服务器环境变量：",
                "The control plane never uses timers or fake states as media readiness. Configure:",
              )}
            </p>
            <code>{overview.missingRequirements.join(" · ")}</code>
          </div>
        </section>
      )}
      {overview.workerError && (
        <section className="cloud-render-requirements warning">
          <AlertTriangle />
          <div>
            <strong>
              {t("Worker 证据不可用", "Worker evidence unavailable")}
            </strong>
            <p>{overview.workerError}</p>
          </div>
        </section>
      )}
      {overview.worker && (
        <section className="cloud-render-worker">
          <article>
            <span>{t("Worker", "Worker")}</span>
            <strong>{overview.worker.workerId}</strong>
            <small>
              {new Date(overview.worker.observedAt).toLocaleString()}
            </small>
          </article>
          <article>
            <span>GPU</span>
            <strong>
              {overview.worker.gpu.vendor} {overview.worker.gpu.model}
            </strong>
            <small>
              {overview.worker.gpu.memoryMiB > 0
                ? `${Math.round(overview.worker.gpu.memoryMiB / 1024)} GB · `
                : ""}
              {overview.worker.gpu.encoder.codecs.join(" / ").toUpperCase()}
            </small>
          </article>
          <article>
            <span>{t("容量", "Capacity")}</span>
            <strong>
              {overview.worker.capacity.activeSessions} /{" "}
              {overview.worker.capacity.maxSessions}
            </strong>
            <small>
              {overview.worker.gpu.encoder.hardware
                ? encoderEvidenceLabel(
                    t,
                    overview.worker.gpu.encoder.evidenceSource,
                  )
                : t("没有硬件编码", "No hardware encoder")}
            </small>
          </article>
        </section>
      )}
      <div className="cloud-render-scenes">
        {overview.scenes.map((scene) => (
          <CloudRenderSceneCard
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
          />
        ))}
        {overview.scenes.length === 0 && (
          <div className="cloud-render-empty">
            <Video />
            <strong>{t("没有已发布场景", "No published scenes")}</strong>
            <span>
              {t(
                "先在场景管理中发布一个场景，再为该发布快照开启云渲染。",
                "Publish a scene first, then enable cloud rendering for that published snapshot.",
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function CloudRenderSceneCard({
  t,
  scene,
  configured,
  busy,
  onEnableAndStart,
  onStart,
  onRefresh,
  onStop,
  onDisable,
}: {
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
  const mediaReady =
    session?.state === "streaming" || session?.state === "degraded";
  const active = Boolean(
    session && !["closed", "failed"].includes(session.state),
  );
  return (
    <article
      className={`cloud-render-scene ${mediaReady ? "media-ready" : ""}`}
    >
      <header>
        <div>
          <CloudCog />
          <span>
            <strong>{scene.name}</strong>
            <small>
              {scene.sceneId} · {new Date(scene.publishedAt).toLocaleString()}
            </small>
          </span>
        </div>
        <i className={mediaReady ? "ready" : (session?.state ?? "disabled")}>
          {statusLabel(t, scene)}
        </i>
      </header>
      {scene.publicationChanged && (
        <div className="cloud-render-warning">
          <AlertTriangle size={14} />
          {t(
            "场景已重新发布，必须停止旧 Worker 会话后重建",
            "Scene was republished; stop the old Worker session before rebuilding",
          )}
        </div>
      )}
      <dl>
        <div>
          <dt>{t("发布作用域", "Published scope")}</dt>
          <dd>
            {scene.projectId} / {scene.sceneId}
          </dd>
        </div>
        <div>
          <dt>{t("管理策略", "Admin policy")}</dt>
          <dd>
            {scene.enabled
              ? t("允许创建会话", "Sessions allowed")
              : t("已关闭", "Disabled")}
          </dd>
        </div>
        <div>
          <dt>{t("控制状态", "Control state")}</dt>
          <dd>
            {session?.state ?? "idle"}
            {session?.failureCode ? ` · ${session.failureCode}` : ""}
          </dd>
        </div>
      </dl>
      {session?.mediaEvidence && (
        <section className="cloud-render-evidence">
          <div>
            <CheckCircle2 />
            <span>
              <strong>{t("媒体已验证", "Media verified")}</strong>
              <small>
                WebRTC outbound-rtp ·{" "}
                {new Date(session.mediaEvidence.observedAt).toLocaleString()}
              </small>
            </span>
          </div>
          <dl>
            <div>
              <dt>{t("编码", "Codec")}</dt>
              <dd>
                {session.mediaEvidence.codec.toUpperCase()} ·{" "}
                {session.mediaEvidence.width}×{session.mediaEvidence.height}
              </dd>
            </div>
            <div>
              <dt>{t("硬件证据", "Hardware proof")}</dt>
              <dd>
                {session.mediaEvidence.encoderEvidence} ·{" "}
                {session.mediaEvidence.encoderImplementation}
              </dd>
            </div>
            <div>
              <dt>{t("计数", "Counters")}</dt>
              <dd>
                {session.mediaEvidence.framesEncoded} frames ·{" "}
                {session.mediaEvidence.packetsSent} packets ·{" "}
                {formatBytes(session.mediaEvidence.bytesSent)}
              </dd>
            </div>
          </dl>
        </section>
      )}
      {session?.viewerUrl &&
        !["closed", "failed", "closing"].includes(session.state) && (
          <a
            className="cloud-render-viewer"
            href={session.viewerUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} />
            {mediaReady
              ? t("打开 Worker 观看端", "Open Worker viewer")
              : t("打开观看端并建立媒体", "Open viewer to establish media")}
          </a>
        )}
      <footer>
        {!scene.enabled && (!session || session.state === "closed") && (
          <button
            className="primary"
            disabled={busy || !configured}
            onClick={onEnableAndStart}
          >
            {busy ? <LoaderCircle className="spin" /> : <Play />}
            {t("启用并启动", "Enable & start")}
          </button>
        )}
        {scene.enabled && (!session || session.state === "closed") && (
          <button
            className="primary"
            disabled={busy || !configured}
            onClick={onStart}
          >
            {busy ? <LoaderCircle className="spin" /> : <Play />}
            {t("创建会话", "Start session")}
          </button>
        )}
        {session && active && (
          <>
            <button disabled={busy} onClick={onRefresh}>
              <RefreshCw />
              {t("验证媒体", "Verify media")}
            </button>
            <button className="danger" disabled={busy} onClick={onDisable}>
              <Square />
              {t("停止并关闭", "Stop & disable")}
            </button>
          </>
        )}
        {session?.state === "failed" && (
          <>
            <button
              disabled={busy || !session.workerSessionId}
              onClick={onStop}
            >
              <Square />
              {t("重试停止 Worker", "Retry Worker stop")}
            </button>
            <button
              className="danger"
              disabled={busy || !session.workerSessionId}
              onClick={onDisable}
            >
              {t("停止并关闭", "Stop & disable")}
            </button>
          </>
        )}
      </footer>
    </article>
  );
}

export function statusLabel(
  t: Translate,
  scene: CloudRenderSceneControl,
): string {
  if (scene.publicationChanged) return t("发布已变化", "Publication changed");
  const state = scene.session?.state;
  if (state === "streaming") return t("媒体运行中", "Media streaming");
  if (state === "degraded") return t("媒体降级", "Media degraded");
  if (state === "signaling" || state === "allocating")
    return t("等待媒体证据", "Awaiting media proof");
  if (state === "closing") return t("正在停止", "Stopping");
  if (state === "failed")
    return t("失败，未确认关闭", "Failed; stop unconfirmed");
  return scene.enabled
    ? t("已启用，未启动", "Enabled; not started")
    : t("已关闭", "Disabled");
}

function formatBytes(value: number): string {
  return value >= 1_048_576
    ? `${(value / 1_048_576).toFixed(1)} MiB`
    : `${Math.round(value / 1024)} KiB`;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function encoderEvidenceLabel(
  t: Translate,
  source: "runtime-loopback" | "operator-attested" | "none" | undefined,
): string {
  if (source === "runtime-loopback")
    return t("真实 WebRTC 回环已验证", "Verified by real WebRTC loopback");
  if (source === "operator-attested")
    return t("运维确认的硬件编码", "Operator-attested hardware encoder");
  return t(
    "硬件编码可用，证据源未声明",
    "Hardware encoder ready; source unspecified",
  );
}
