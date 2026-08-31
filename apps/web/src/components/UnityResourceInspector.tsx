import { Box, Download, LoaderCircle, RefreshCw, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import {
  assessUnityWidgetReadiness,
  type DashboardDataWidgetConfig,
  type UnityResourceRecord,
  type UnityResourceVersionRecord,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { reconcileUnityVersionWidget } from "../unityBridge";
import type { UnityUploadProgress } from "../api";
import type { UnityRuntimeStatusDetail } from "./UnitySceneEmbed";
import {
  UnityContractConfiguration,
  UnityExternalRuntimeStatus,
  UnityPublicationAndHosting,
} from "./UnityResourceSections";

export const UNITY_BRIDGE_PACKAGE_URL = `${import.meta.env.BASE_URL}downloads/com.bim-studio.bridge-0.6.0.tgz`;

export function isUnityWebGlZip(fileName: string): boolean {
  return /\.zip$/i.test(fileName.trim());
}

interface Props {
  locale: AppLocale;
  projectId: string;
  widgetId?: string;
  widget: DashboardDataWidgetConfig;
  onChange: (patch: Partial<DashboardDataWidgetConfig>) => void;
}

/** 统一处理 Unity 资源导入和版本选择，契约配置拆到独立展示组件以保持职责清晰。 */
export function UnityResourceInspector({ locale, projectId, widgetId, widget, onChange }: Props) {
  const [resources, setResources] = useState<UnityResourceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [uploadProgress, setUploadProgress] = useState<UnityUploadProgress>();
  const [dragActive, setDragActive] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<Omit<UnityRuntimeStatusDetail, "widgetId">>();
  const inputRef = useRef<HTMLInputElement>(null);
  const resource = resources.find((item) => item.id === widget.unityResourceId);
  const version = useMemo(
    () => resource?.versions.find((item) => item.id === widget.unityResourceVersionId)
      ?? resource?.versions.find((item) => item.id === resource.activeVersionId),
    [resource, widget.unityResourceVersionId],
  );
  const readiness = useMemo(() => assessUnityWidgetReadiness(widget, resources), [resources, widget]);

  useEffect(() => { void refresh(); }, [projectId]);
  useEffect(() => {
    if (!widgetId) return;
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<UnityRuntimeStatusDetail>).detail;
      if (detail?.widgetId !== widgetId || !detail.state) return;
      const { widgetId: _widgetId, ...status } = detail;
      setRuntimeStatus(status);
    };
    window.addEventListener("bim-studio:unity-status", receive);
    return () => window.removeEventListener("bim-studio:unity-status", receive);
  }, [widgetId]);

  async function refresh() {
    setLoading(true);
    try {
      const { api } = await import("../api");
      setResources(await api.listUnityResources(projectId));
      setMessage("");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  function selectVersion(nextResource: UnityResourceRecord, nextVersion: UnityResourceVersionRecord) {
    onChange(reconcileUnityVersionWidget(widget, nextResource, nextVersion));
  }

  function testDefaultAction() {
    if (!widgetId || !widget.unityDefaultAction?.action) return;
    window.dispatchEvent(new CustomEvent("bim-studio:unity-action", {
      detail: {
        widgetId,
        action: widget.unityDefaultAction.action,
        objectId: widget.unityDefaultAction.objectId,
      },
    }));
  }

  async function upload(file?: File) {
    if (!file) return;
    if (!isUnityWebGlZip(file.name)) {
      setMessage(tr(locale, "请拖入 Unity 导出的 WebGL ZIP 文件", "Drop the WebGL ZIP exported by Unity"));
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const { api } = await import("../api");
      const previousVersionCount = resource?.versions.length ?? 0;
      const next = await api.uploadUnityResource(
        projectId,
        file,
        resource
          ? { resourceId: resource.id, name: resource.name, onProgress: setUploadProgress }
          : { name: file.name.replace(/\.zip$/i, ""), onProgress: setUploadProgress },
      );
      const active = next.versions.find((item) => item.id === next.activeVersionId)!;
      setResources((current) => [next, ...current.filter((item) => item.id !== next.id)]);
      selectVersion(next, active);
      const deduplicated = Boolean(resource && next.versions.length === previousVersionCount);
      setMessage(deduplicated
        ? tr(locale, `相同构建已存在，已切换到 v${active.version}`, `Identical build already exists; switched to v${active.version}`)
        : tr(locale, `已导入 Unity 资源 v${active.version}`, `Imported Unity resource v${active.version}`));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
      setUploadProgress(undefined);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function dropBuild(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = [...event.dataTransfer.files].find((candidate) => isUnityWebGlZip(candidate.name));
    if (file) void upload(file);
    else setMessage(tr(locale, "未找到可导入的 .zip 构建包", "No importable .zip build was found"));
  }

  return <div
    className={`unity-resource-inspector ${dragActive ? "is-dragging" : ""}`}
    onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
    onDrop={dropBuild}
  >
    <div className="unity-bridge-onboarding">
      <div>
        <strong>{tr(locale, "Unity 三步接入", "Unity in three steps")}</strong>
        <small>{tr(locale, "下载插件并通过 Package Manager 安装 → 在 Unity 一键导出 WebGL ZIP → 将 ZIP 拖入这里。无需编写桥接代码。", "Install the package with Package Manager → export a WebGL ZIP in Unity → drag the ZIP here. No bridge code required.")}</small>
      </div>
      <a href={UNITY_BRIDGE_PACKAGE_URL} download><Download size={13} />{tr(locale, "下载中文插件", "Download plugin")}</a>
    </div>

    <div className="unity-resource-primary">
      <label><span>{tr(locale, "Unity 资源", "Unity resource")}</span><select
        value={resource?.id ?? ""}
        onChange={(event) => {
          const next = resources.find((item) => item.id === event.target.value);
          const active = next?.versions.find((item) => item.id === next.activeVersionId);
          if (next && active) selectVersion(next, active);
        }}
      >
        <option value="">{tr(locale, "选择已导入资源", "Choose imported resource")}</option>
        {resources.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.versions.find((candidate) => candidate.id === item.activeVersionId)?.version ?? 1}</option>)}
      </select></label>
      <button disabled={loading} onClick={() => inputRef.current?.click()}>
        {loading ? <LoaderCircle className="spin" size={13} /> : resource ? <RefreshCw size={13} /> : <Upload size={13} />}
        {resource ? tr(locale, "上传新版本", "Upload version") : tr(locale, "导入 ZIP", "Import ZIP")}
      </button>
      <input ref={inputRef} hidden type="file" accept=".zip,application/zip" onChange={(event) => void upload(event.target.files?.[0])} />
    </div>

    {dragActive && <div className="unity-resource-drop-hint"><Upload size={15} />{tr(locale, "松开即可导入 Unity WebGL ZIP", "Drop to import the Unity WebGL ZIP")}</div>}
    {uploadProgress && <div className={`unity-upload-progress ${uploadProgress.phase}`}>
      <div><span style={{ width: `${uploadProgress.percent}%` }} /></div>
      <small>{uploadProgress.phase === "uploading" ? tr(locale, `正在上传 ${uploadProgress.percent}%`, `Uploading ${uploadProgress.percent}%`) : tr(locale, "上传完成，正在校验并解压…", "Upload complete; validating and extracting…")}</small>
    </div>}

    {resource && version && <>
      <label><span>{tr(locale, "资源版本", "Resource version")}</span><select value={version.id} onChange={(event) => {
        const next = resource.versions.find((item) => item.id === event.target.value);
        if (next) selectVersion(resource, next);
      }}>{resource.versions.map((item) => <option key={item.id} value={item.id}>v{item.version} · {new Date(item.createdAt).toLocaleString(locale)}</option>)}</select></label>
      <div className="unity-resource-summary"><Box size={14} /><span>
        <strong>{version.manifest.unityVersion || tr(locale, "Unity 版本未声明", "Unity version not declared")}</strong>
        <small>{version.fileCount} files · {Math.max(1, Math.round(version.size / 1024 / 1024))} MiB · Bridge v{version.manifest.bridgeVersion}</small>
      </span></div>
      <UnityContractConfiguration
        locale={locale}
        version={version}
        widget={widget}
        {...(runtimeStatus ? { runtimeStatus } : {})}
        onChange={onChange}
        onTestAction={testDefaultAction}
      />
    </>}

    {!version && widget.unityUrl && <UnityExternalRuntimeStatus locale={locale} {...(runtimeStatus ? { status: runtimeStatus } : {})} />}

    <UnityPublicationAndHosting locale={locale} widget={widget} readiness={readiness} loading={loading} onChange={onChange} />
    {message && <small className="unity-resource-message">{message}</small>}
  </div>;
}
