import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ApplicationScriptDependency, ScriptModule } from "@bim-studio/contracts";
import {
  CheckCircle2,
  Download,
  FileCode2,
  HardDriveDownload,
  Link2,
  PackagePlus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "../api";
import { downloadBlob } from "../browserDownload";
import {
  dependencyImportSnippet,
  dependencySourceLabel,
  findDependencyReferences,
  formatDependencyBytes,
  parseNpmRequest,
  shortIntegrity,
  validateDependencyDraft,
  type ScriptDependencyInstallMode,
} from "./scriptDependencyManagerModel";
import "./ScriptDependencyManager.css";

export type ScriptDependencyClient = Pick<
  typeof api,
  | "installNpmScriptDependency"
  | "installExternalScriptDependency"
  | "uploadScriptDependency"
  | "downloadScriptDependency"
  | "deleteScriptDependency"
>;

export interface ScriptDependencyManagerProps {
  projectId?: string;
  dependencies: readonly ApplicationScriptDependency[];
  scripts: readonly Pick<ScriptModule, "id" | "name" | "code">[];
  activeScriptName?: string;
  installationDisabled?: boolean;
  installationDisabledReason?: string;
  client?: ScriptDependencyClient;
  onDependenciesChange: (dependencies: readonly ApplicationScriptDependency[]) => void | Promise<void>;
  onInsertImport: (snippet: string, dependency: ApplicationScriptDependency) => void;
  onClose: () => void;
}

type Feedback = { tone: "success" | "warning" | "error"; text: string };

/** 项目级依赖只负责安装、锁定和引用治理；代码编辑仍留在主编辑器。 */
export function ScriptDependencyManager(props: ScriptDependencyManagerProps) {
  const client = props.client ?? api;
  const [query, setQuery] = useState("");
  const [formOpen, setFormOpen] = useState(props.dependencies.length === 0);
  const [mode, setMode] = useState<ScriptDependencyInstallMode>("npm");
  const [editingId, setEditingId] = useState<string>();
  const [packageName, setPackageName] = useState("");
  const [version, setVersion] = useState("");
  const [specifier, setSpecifier] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [uploadFile, setUploadFile] = useState<File>();
  const [busyAction, setBusyAction] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>();
  const managerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busyActionRef = useRef(busyAction);
  const onCloseRef = useRef(props.onClose);
  const editing = props.dependencies.find((dependency) => dependency.id === editingId);
  const canInstall = Boolean(props.projectId) && !props.installationDisabled;

  busyActionRef.current = busyAction;
  onCloseRef.current = props.onClose;

  const references = useMemo(
    () => new Map(props.dependencies.map((dependency) => [dependency.id, findDependencyReferences(props.scripts, dependency.specifier)])),
    [props.dependencies, props.scripts],
  );
  const visibleDependencies = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return props.dependencies;
    return props.dependencies.filter((dependency) =>
      `${dependency.specifier} ${dependency.requested} ${dependency.resolvedVersion ?? ""} ${dependencySourceLabel(dependency.source)}`
        .toLocaleLowerCase()
        .includes(needle),
    );
  }, [props.dependencies, query]);
  const totalSize = props.dependencies.reduce((sum, dependency) => sum + dependency.size, 0);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyActionRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      // 对话框打开期间把键盘焦点限制在抽屉内，避免误操作被遮罩的脚本编辑器。
      const focusable = findFocusableElements(managerRef.current);
      if (!focusable.length) {
        event.preventDefault();
        managerRef.current?.focus();
        return;
      }
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      let target: HTMLElement | undefined;
      if (event.shiftKey && currentIndex <= 0) target = focusable[focusable.length - 1];
      if (!event.shiftKey && (currentIndex === -1 || currentIndex === focusable.length - 1)) target = focusable[0];
      if (target) {
        event.preventDefault();
        target.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, []);

  function resetForm(nextMode: ScriptDependencyInstallMode = "npm") {
    setMode(nextMode);
    setEditingId(undefined);
    setPackageName("");
    setVersion("");
    setSpecifier("");
    setExternalUrl("");
    setUploadFile(undefined);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function beginAdd() {
    resetForm("npm");
    setFeedback(undefined);
    setFormOpen(true);
  }

  function selectMode(nextMode: ScriptDependencyInstallMode) {
    if (editingId || nextMode === mode) return;
    resetForm(nextMode);
  }

  function beginUpdate(dependency: ApplicationScriptDependency) {
    resetForm(dependency.source);
    setEditingId(dependency.id);
    setSpecifier(dependency.specifier);
    if (dependency.source === "npm") {
      const npm = parseNpmRequest(dependency.requested, dependency.resolvedVersion);
      setPackageName(npm.packageName);
      setVersion(npm.version);
    } else if (dependency.source === "external-url") {
      setExternalUrl(dependency.requested);
    }
    setFeedback(undefined);
    setFormOpen(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = { mode, specifier, packageName, version, url: externalUrl, ...(uploadFile ? { file: uploadFile } : {}) };
    const validationError = validateDependencyDraft(draft);
    if (validationError) return setFeedback({ tone: "error", text: validationError });
    if (!props.projectId || !canInstall) {
      return setFeedback({ tone: "error", text: props.installationDisabledReason || "当前项目不能安装依赖" });
    }
    const normalizedSpecifier = specifier.trim();
    const duplicate = props.dependencies.find((dependency) => dependency.id !== editingId && dependency.specifier.toLocaleLowerCase() === normalizedSpecifier.toLocaleLowerCase());
    if (duplicate) return setFeedback({ tone: "error", text: `模块名 ${normalizedSpecifier} 已存在，请在原依赖上更新` });

    setBusyAction("install");
    setFeedback(undefined);
    try {
      const installed = await installDependency(client, props.projectId, draft, uploadFile);
      const next = editing
        ? props.dependencies.map((dependency) => dependency.id === editing.id ? installed : dependency)
        : [...props.dependencies, installed];
      try {
        await props.onDependenciesChange(next);
      } catch (reason) {
        await client.deleteScriptDependency(props.projectId, installed.id).catch(() => undefined);
        throw reason;
      }

      let cleanupWarning = false;
      if (editing) {
        try {
          await client.deleteScriptDependency(props.projectId, editing.id);
        } catch {
          cleanupWarning = true;
        }
      }
      setFeedback(cleanupWarning
        ? { tone: "warning", text: "新版本已生效，旧缓存未清理；可稍后重试更新" }
        : { tone: "success", text: editing ? "依赖已更新并重新锁定" : "依赖已安装到项目缓存" });
      resetForm(mode);
      setFormOpen(false);
    } catch (reason) {
      setFeedback({ tone: "error", text: errorMessage(reason, editing ? "依赖更新失败" : "依赖安装失败") });
    } finally {
      setBusyAction("");
    }
  }

  async function downloadDependency(dependency: ApplicationScriptDependency) {
    if (!props.projectId) return setFeedback({ tone: "error", text: "当前项目缺少下载上下文" });
    setBusyAction(`download:${dependency.id}`);
    setFeedback(undefined);
    try {
      downloadBlob(await client.downloadScriptDependency(props.projectId, dependency.id), dependency.fileName);
      setFeedback({ tone: "success", text: `${dependency.specifier} 已开始下载` });
    } catch (reason) {
      setFeedback({ tone: "error", text: errorMessage(reason, "依赖下载失败") });
    } finally {
      setBusyAction("");
    }
  }

  async function deleteDependency(dependency: ApplicationScriptDependency) {
    const usage = references.get(dependency.id) ?? [];
    if (usage.length) return setFeedback({ tone: "error", text: `先移除 ${usage.map((item) => item.name).join("、")} 中的 import` });
    if (!props.projectId) return setFeedback({ tone: "error", text: "当前项目缺少删除上下文" });
    setBusyAction(`delete:${dependency.id}`);
    setFeedback(undefined);
    const previous = [...props.dependencies];
    const next = props.dependencies.filter((item) => item.id !== dependency.id);
    try {
      await props.onDependenciesChange(next);
      try {
        await client.deleteScriptDependency(props.projectId, dependency.id);
      } catch (reason) {
        await props.onDependenciesChange(previous);
        throw reason;
      }
      setConfirmDeleteId(undefined);
      setFeedback({ tone: "success", text: `${dependency.specifier} 已删除` });
    } catch (reason) {
      setFeedback({ tone: "error", text: errorMessage(reason, "依赖删除失败") });
    } finally {
      setBusyAction("");
    }
  }

  function insertImport(dependency: ApplicationScriptDependency) {
    try {
      props.onInsertImport(dependencyImportSnippet(dependency.specifier), dependency);
      setFeedback({ tone: "success", text: `已插入 ${dependency.specifier} 的 import${props.activeScriptName ? ` 到“${props.activeScriptName}”` : ""}` });
    } catch (reason) {
      setFeedback({ tone: "error", text: errorMessage(reason, "无法插入当前脚本") });
    }
  }

  return (
    <div className="script-dependency-overlay" role="presentation">
      <aside ref={managerRef} className="script-dependency-manager" role="dialog" aria-modal="true" aria-labelledby="script-dependency-title" tabIndex={-1}>
        <header className="script-dependency-header">
          <span><PackagePlus size={18} /></span>
          <div>
            <strong id="script-dependency-title">项目依赖</strong>
            <small>{props.dependencies.length} 项 · {formatDependencyBytes(totalSize)}</small>
          </div>
          <button className="script-dependency-primary" type="button" disabled={!canInstall || Boolean(busyAction)} onClick={beginAdd}>
            <PackagePlus size={13} />添加依赖
          </button>
          <button ref={closeButtonRef} className="script-dependency-icon" type="button" aria-label="关闭项目依赖" title="关闭项目依赖" disabled={Boolean(busyAction)} onClick={props.onClose}>
            <X size={15} />
          </button>
        </header>

        <div className="script-dependency-local-status">
          <ShieldCheck size={15} />
          <p><strong>运行内容已本地化</strong><span>安装时获取并锁定哈希；预览、发布和离线客户端不访问原始来源。</span></p>
        </div>

        {!canInstall && (
          <p className="script-dependency-readonly">
            {props.installationDisabledReason || "当前为只读或离线编辑上下文；已安装依赖仍可查看和插入。"}
          </p>
        )}

        {formOpen && (
          <form className="script-dependency-form" onSubmit={(event) => void submit(event)}>
            <header>
              <div><strong>{editing ? `更新 ${editing.specifier}` : "添加项目依赖"}</strong><small>{editing ? "模块名保持不变，重新生成本地缓存" : "选择一种可信来源"}</small></div>
              <button type="button" onClick={() => { resetForm(); setFormOpen(false); }}>取消</button>
            </header>
            <nav aria-label="依赖来源">
              <SourceTab active={mode === "npm"} disabled={Boolean(editingId)} icon={<PackagePlus size={13} />} label="npm" onClick={() => selectMode("npm")} />
              <SourceTab active={mode === "upload"} disabled={Boolean(editingId)} icon={<Upload size={13} />} label="本地 JS" onClick={() => selectMode("upload")} />
              <SourceTab active={mode === "external-url"} disabled={Boolean(editingId)} icon={<Link2 size={13} />} label="外部 URL" onClick={() => selectMode("external-url")} />
            </nav>
            {mode === "npm" && (
              <div className="script-dependency-fields two-columns">
                <label><span>npm 包名</span><input value={packageName} placeholder="dayjs" autoComplete="off" onChange={(event) => {
                  const next = event.target.value;
                  if (!editingId && (!specifier || specifier === packageName)) setSpecifier(next);
                  setPackageName(next);
                }} /></label>
                <label><span>固定版本</span><input value={version} placeholder="1.11.13" autoComplete="off" onChange={(event) => setVersion(event.target.value)} /></label>
              </div>
            )}
            {mode === "external-url" && (
              <label className="script-dependency-wide-field"><span>外部 JS 地址</span><input type="url" value={externalUrl} placeholder="https://cdn.example.com/module.js" onChange={(event) => setExternalUrl(event.target.value)} /></label>
            )}
            {mode === "upload" && (
              <label className="script-dependency-upload">
                <FileCode2 size={18} /><span>{uploadFile?.name ?? (editing ? "选择新文件替换当前缓存" : "选择 .js 或 .mjs 文件")}</span>
                <input ref={fileInputRef} type="file" accept=".js,.mjs,text/javascript" onChange={(event) => setUploadFile(event.target.files?.[0])} />
              </label>
            )}
            <div className="script-dependency-fields footer-fields">
              <label><span>模块名（import）</span><input value={specifier} readOnly={Boolean(editing)} placeholder="dayjs" autoComplete="off" onChange={(event) => setSpecifier(event.target.value)} /></label>
              <button className="script-dependency-primary" type="submit" disabled={!canInstall || Boolean(busyAction)}>
                {busyAction === "install" ? <RefreshCw className="spin" size={13} /> : <HardDriveDownload size={13} />}
                {editing ? "更新本地缓存" : "安装并本地化"}
              </button>
            </div>
          </form>
        )}

        <div className="script-dependency-toolbar">
          <label role="search" aria-label="搜索项目依赖" title="搜索项目依赖"><Search size={14} /><input aria-label="搜索项目依赖" value={query} placeholder="搜索模块、版本或来源" onChange={(event) => setQuery(event.target.value)} /></label>
          <span>{visibleDependencies.length === props.dependencies.length ? `${props.dependencies.length} 项` : `${visibleDependencies.length} / ${props.dependencies.length}`}</span>
        </div>

        {feedback && <p className={`script-dependency-feedback ${feedback.tone}`} role="status">{feedback.tone === "success" && <CheckCircle2 size={13} />}{feedback.text}</p>}

        <div className="script-dependency-list">
          {visibleDependencies.map((dependency) => {
            const usage = references.get(dependency.id) ?? [];
            const deleting = confirmDeleteId === dependency.id;
            const busy = busyAction.endsWith(dependency.id);
            return (
              <article key={dependency.id} className="script-dependency-card">
                <header>
                  <span className={`source ${dependency.source}`}><DependencySourceIcon source={dependency.source} /></span>
                  <div><strong>{dependency.specifier}</strong><small title={dependency.requested}>{dependencySourceLabel(dependency.source)} · {dependency.resolvedVersion ?? dependency.requested}</small></div>
                  <b title={`安装于 ${formatInstalledAt(dependency.installedAt)}`}><ShieldCheck size={11} />已本地化</b>
                </header>
                <dl>
                  <div><dt>来源</dt><dd>{dependencySourceLabel(dependency.source)}</dd></div>
                  <div><dt>版本</dt><dd>{dependency.resolvedVersion ?? "—"}</dd></div>
                  <div><dt>大小</dt><dd>{formatDependencyBytes(dependency.size)}</dd></div>
                  <div><dt>哈希</dt><dd title={dependency.integrity}>{shortIntegrity(dependency.integrity)}</dd></div>
                  <div><dt>引用</dt><dd title={usage.map((item) => item.name).join("、")}>{usage.length ? `${usage.length} 个脚本` : "未引用"}</dd></div>
                </dl>
                <footer>
                  <button type="button" disabled={Boolean(busyAction)} onClick={() => insertImport(dependency)}><FileCode2 size={12} />插入 import</button>
                  <button type="button" disabled={!props.projectId || Boolean(busyAction)} onClick={() => void downloadDependency(dependency)}><Download size={12} />下载</button>
                  <button type="button" disabled={!canInstall || Boolean(busyAction)} onClick={() => beginUpdate(dependency)}><RefreshCw className={busy ? "spin" : ""} size={12} />更新</button>
                  {deleting ? (
                    <span className="script-dependency-confirm"><button className="danger" type="button" disabled={busy} onClick={() => void deleteDependency(dependency)}>确认删除</button><button type="button" disabled={busy} onClick={() => setConfirmDeleteId(undefined)}>取消</button></span>
                  ) : (
                    <button className="danger" type="button" disabled={!canInstall || Boolean(busyAction) || usage.length > 0} title={usage.length ? `被 ${usage.map((item) => item.name).join("、")} 引用，不能删除` : "删除项目缓存"} onClick={() => setConfirmDeleteId(dependency.id)}><Trash2 size={12} />删除</button>
                  )}
                </footer>
              </article>
            );
          })}
          {!visibleDependencies.length && (
            <div className="script-dependency-empty"><PackagePlus size={28} /><strong>{query ? "没有匹配的依赖" : "还没有项目依赖"}</strong><span>{query ? "换一个模块名或来源" : "添加固定版本或本地文件，运行时不再访问来源站点。"}</span></div>
          )}
        </div>
      </aside>
    </div>
  );
}

function SourceTab(props: { active: boolean; disabled: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button type="button" className={props.active ? "active" : ""} aria-pressed={props.active} disabled={props.disabled && !props.active} onClick={props.onClick}>{props.icon}{props.label}</button>;
}

function DependencySourceIcon({ source }: { source: ApplicationScriptDependency["source"] }) {
  if (source === "npm") return <PackagePlus size={14} />;
  if (source === "upload") return <FileCode2 size={14} />;
  return <Link2 size={14} />;
}

async function installDependency(
  client: ScriptDependencyClient,
  projectId: string,
  draft: { mode: ScriptDependencyInstallMode; specifier: string; packageName: string; version: string; url: string },
  file?: File,
): Promise<ApplicationScriptDependency> {
  if (draft.mode === "npm") return client.installNpmScriptDependency(projectId, draft.packageName.trim(), draft.version.trim(), draft.specifier.trim());
  if (draft.mode === "external-url") return client.installExternalScriptDependency(projectId, draft.url.trim(), draft.specifier.trim());
  if (!file) throw new Error("请选择 JavaScript 文件");
  return client.uploadScriptDependency(projectId, draft.specifier.trim(), file);
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback;
}

function formatInstalledAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(timestamp) : "未知";
}

function findFocusableElements(root?: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((element) => {
    const style = window.getComputedStyle(element);
    return !element.hidden && element.getAttribute("aria-hidden") !== "true" && style.display !== "none" && style.visibility !== "hidden";
  });
}
