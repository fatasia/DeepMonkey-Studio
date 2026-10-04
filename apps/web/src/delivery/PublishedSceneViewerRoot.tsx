import { useEffect, useRef, useState } from "react";
import { Eye, RefreshCw, TriangleAlert } from "lucide-react";
import {
  getSceneModelAssetId,
  type ProjectRecord,
  type PublishedSceneRecord,
  type SystemBrandingSettings,
} from "@bim-studio/contracts";
import { applyDocumentBranding } from "../branding/documentBranding";
import type { AppLocale } from "../i18n";
import { publishedApplicationApi, type PublishedSceneBrowseRecord } from "../apiClients/publishedApplicationApi";
import { rendererRequirementsForScene, resolvePublishedRenderer } from "../rendererCapabilities";
import { ViewerEngine } from "../viewer/ViewerEngine";
import { applySceneViewerSnapshot } from "./applySceneViewerSnapshot";
import { PublishedModelCredits } from "./PublishedModelCredits";
import "./published-application.css";

/**
 * 匿名 Web 发布页：消费服务端公开只读端点（/api/public/scenes/:id/browse），
 * 用独立 ViewerEngine 渲染发布快照。不挂登录门、作者仓库或任何写回调；
 * 「复制发布链接」分享给无账号用户时即落在这里。
 */
export function PublishedSceneViewerRoot({ sceneId }: { sceneId?: string }) {
  const [record, setRecord] = useState<PublishedSceneBrowseRecord>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [locale, setLocale] = useState<AppLocale>("zh-CN");
  const [branding, setBranding] = useState<SystemBrandingSettings>();
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setRecord(undefined); setError(""); setReady(false); setLoadError("");
    if (!sceneId?.trim()) { setError("发布链接无效，请检查场景地址。"); return; }
    void publishedApplicationApi.branding(controller.signal).then((settings) => {
      if (controller.signal.aborted) return;
      setBranding(settings);
      setLocale(settings.defaultLocale);
    }).catch(() => { /* 品牌是可选增强，公开场景在无品牌配置时也要能打开。 */ });
    void publishedApplicationApi.sceneBrowse(sceneId, controller.signal).then((body) => {
      if (controller.signal.aborted) return;
      setRecord(body);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "发布场景加载失败，请稍后重试。");
    });
    return () => controller.abort();
  }, [sceneId, attempt]);

  useEffect(() => {
    const title = record ? `${record.publication.name} · 发布场景` : "发布场景";
    if (branding) applyDocumentBranding({ ...branding, browserTitle: title });
    else document.title = title;
  }, [record, branding]);

  useEffect(() => {
    const container = containerRef.current;
    if (!record || !container) return;
    let cancelled = false;
    let engine: ViewerEngine | undefined;
    const dispose = () => {
      cancelled = true;
      engine?.dispose();
      engine = undefined;
    };
    void (async () => {
      const snapshot = record.publication.snapshot;
      const mount = async (backend: "webgl" | "webgpu") => {
        const created = await ViewerEngine.create(container, backend);
        if (cancelled) { created.dispose(); return undefined; }
        engine = created;
        await applySceneViewerSnapshot(created, snapshot, record.project, { isCancelled: () => cancelled });
        return created;
      };
      try {
        const decision = await resolvePublishedRenderer(snapshot.publicationMode ?? "webgl", rendererRequirementsForScene(snapshot));
        if (cancelled) return;
        try {
          await mount(decision.backend);
        } catch (reason) {
          if (cancelled) return;
          engine?.dispose();
          engine = undefined;
          // 与登录态发布页同语义：WebGPU 初始化失败时回退 WebGL，不给匿名访客白屏。
          if (decision.backend !== "webgl") {
            await mount("webgl");
          } else throw reason;
        }
        if (cancelled) return;
        setReady(true);
      } catch (reason) {
        if (!cancelled) setLoadError(reason instanceof Error ? reason.message : "场景内容加载失败，请刷新重试。");
      }
    })();
    return dispose;
  }, [record]);

  if (!record) return <main className="app-shell published-application published-application-state" aria-busy={!error}>
    <section role={error ? "alert" : "status"}>
      {error ? <TriangleAlert size={30} /> : <RefreshCw className="spin" size={30} />}
      <h1>{error ? "暂时无法打开发布场景" : "正在加载发布场景"}</h1>
      <p>{error || "正在读取该场景的正式发布版本。"}</p>
      {error && <button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} />重新加载</button>}
    </section>
  </main>;

  const { publication, project } = record;
  return <div className="app-shell published-application">
    <div className="published-scene-viewer-viewport" ref={containerRef} aria-hidden={Boolean(loadError)} />
    {!ready && !loadError && <div className="published-scene-viewer-status" role="status"><RefreshCw className="spin" size={22} />正在渲染发布场景…</div>}
    {loadError && <div className="published-scene-viewer-status" role="alert"><TriangleAlert size={22} />{loadError}</div>}
    <header className="published-application-header">
      <Eye size={15} aria-hidden="true" />
      <strong title={publication.name}>{publication.name}</strong>
      <small>只读发布版 · {new Date(publication.publishedAt).toLocaleString(locale)}</small>
    </header>
    <PublishedModelCredits locale={locale} models={project.models} modelIds={publication.snapshot.models.map(getSceneModelAssetId)} />
  </div>;
}
