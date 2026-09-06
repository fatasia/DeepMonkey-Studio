import { useEffect, useState } from "react";
import { Info, RefreshCw, TriangleAlert, X } from "lucide-react";
import { publishedApplicationApi, type PublishedApplicationBundle } from "../apiClients/publishedApplicationApi";
import { applyDocumentBranding } from "../branding/documentBranding";
import { DashboardPlayback } from "../components/DashboardPlayback";
import { subscribeApplicationInteractionEffects } from "../studio/applicationInteractionHost";
import type { AppLocale } from "../i18n";
import { getSceneModelAssetId, type SystemBrandingSettings } from "@bim-studio/contracts";
import { publicApplicationAction, publishedApplicationId, publishedEntryPage } from "./publishedApplicationModel";
import "./published-application.css";
import { PublishedModelCredits } from "./PublishedModelCredits";

/** No author store, workspace hydration, login gate or write callbacks are mounted. */
export function PublishedApplicationRoot() {
  const [bundle, setBundle] = useState<PublishedApplicationBundle>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [locale, setLocale] = useState<AppLocale>("zh-CN");
  const [branding, setBranding] = useState<SystemBrandingSettings>();
  const [pageId, setPageId] = useState("");
  const [notice, setNotice] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const applicationId = publishedApplicationId(window.location.pathname);
    setBundle(undefined); setError(""); setNotice("");
    if (!applicationId) { setError("发布链接无效，请检查应用地址。"); return; }
    void publishedApplicationApi.branding(controller.signal).then(branding => {
      if (controller.signal.aborted) return;
      setBranding(branding);
      setLocale(branding.defaultLocale);
      document.documentElement.lang = branding.defaultLocale;
    }).catch(() => { /* Publication remains usable if optional branding is unavailable. */ });
    void publishedApplicationApi.browse(applicationId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const page = publishedEntryPage(result.publication.document);
      if (!page) throw new Error("这个发布版本没有可浏览的页面，请联系发布者添加页面后重新发布。");
      setPageId(page.id); setBundle(result);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "发布应用加载失败，请重试。"); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    const title = bundle ? `${bundle.publication.document.metadata.name} · 发布运行` : "发布应用";
    if (branding) applyDocumentBranding({ ...branding, browserTitle: title });
    else document.title = title;
  }, [bundle, branding]);
  useEffect(() => {
    if (!bundle) return;
    const { document: application } = bundle.publication;
    return subscribeApplicationInteractionEffects(({ action }) => {
      const effect = publicApplicationAction(application, action, window.location.origin);
      if (!effect) return;
      if ("pageId" in effect) setPageId(effect.pageId);
      else if ("message" in effect) setNotice(effect.message);
      else {
        // Script-origin navigation may be blocked by the browser: keep a user-clickable link.
        setNotice(`链接：${effect.url}`);
      }
    });
  }, [bundle]);

  if (!bundle) return <main className="app-shell published-application published-application-state" aria-busy={!error}>
    <section role={error ? "alert" : "status"}>
      {error ? <TriangleAlert size={30} /> : <RefreshCw className="spin" size={30} />}
      <h1>{error ? "暂时无法打开应用" : "正在加载发布应用"}</h1>
      <p>{error || "正在读取正式版本，脚本将在页面就绪后自动运行。"}</p>
      {error && <button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} />重新加载</button>}
    </section>
  </main>;
  const { publication, project } = bundle;
  const application = publication.document;
  const page = application.pages.find(page => page.id === pageId) ?? publishedEntryPage(application)!;
  return <div className="app-shell published-application">
    <DashboardPlayback key={`${publication.id}:${attempt}`} readOnly locale={locale} application={application} project={project} page={page} rendererBackend="webgl"
      metrics={{}} variables={{}} filters={{}} connected={false}
      readDependency={(_projectId, dependencyId) => publishedApplicationApi.dependency(application.metadata.id, publication.id, dependencyId)}
      onSelectPage={setPageId} onClose={() => undefined} onPublish={() => undefined} onFilterChange={() => undefined} onVariableChange={() => undefined}
      onSelectionChange={() => undefined} onObjectInteraction={() => undefined} onNodeInteraction={() => undefined} />
    <header className="published-application-header">
      <strong title={application.metadata.name}>{application.metadata.name}</strong>
      <small>发布版本 {publication.applicationRevision}</small>
      <button type="button" title="发布说明" aria-label="发布说明" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)}><Info size={15} /></button>
      <button type="button" title="刷新发布版本" aria-label="刷新发布版本" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} /></button>
    </header>
    <PublishedModelCredits locale={locale} models={project.models} modelIds={application.scenes.flatMap(scene => scene.models.map(getSceneModelAssetId))} />
    {detailsOpen && <aside className="published-application-details" aria-label="发布说明">
      <strong>正式版本 · 只读运行</strong>
      <p>发布于 {new Date(publication.publishedAt).toLocaleString(locale)}。交互、筛选和脚本数据只存在于本次运行，不会修改编辑草稿。</p>
      <p>公开页使用快照内容与本地脚本数据。受保护数据源、AI、媒体网关及旧式主线程事件脚本未在匿名页启用；请由发布者配置后续发布授权。</p>
    </aside>}
    {notice && <aside className="published-application-notice" role="status">
      {notice.startsWith("链接：http") ? <a href={notice.slice(3)} target="_blank" rel="noopener noreferrer">打开链接</a> : <span>{notice}</span>}
      <button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={14} /></button>
    </aside>}
  </div>;
}
