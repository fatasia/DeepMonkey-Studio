import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Code2, FilePlus2 } from "lucide-react";
import { SDK_EXAMPLES, type SdkExampleId } from "../docs/sdkExamples";
import { sdkExampleUnavailableReason, type SdkExampleWorkspaceContext } from "../behavior/sdkExampleInsertion";
import { DocsCenterCodeBlock } from "./DocsCenterCodeBlock";
import "./DocsSdkExamples.css";

export interface DocsSdkExamplesProps {
  context?: SdkExampleWorkspaceContext;
  onInsert?: (exampleId: SdkExampleId) => void | Promise<void>;
}

export function DocsSdkExamples({ context = { authenticated: false }, onInsert }: DocsSdkExamplesProps) {
  const [selectedId, setSelectedId] = useState<SdkExampleId>("lifecycle");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const busyRef = useRef(false);
  const live = useRef(true);
  const scope = `${context.authenticated}:${context.projectId ?? ""}:${context.applicationId ?? ""}`;
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const selected = SDK_EXAMPLES.find(example => example.id === selectedId)!;
  const unavailableReason = sdkExampleUnavailableReason(context) ?? (!onInsert ? "当前入口仅支持浏览，请从项目编辑器重新打开文档。" : undefined);

  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { setConfirming(false); setFeedback(""); }, [scope]);
  useEffect(() => {
    if (!confirming) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busyRef.current) return;
      event.preventDefault();
      setConfirming(false);
      setFeedback("已取消新增，当前文件保持不变。");
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [confirming]);

  async function insert() {
    if (busyRef.current || unavailableReason || !onInsert) return;
    const insertionScope = scope;
    busyRef.current = true;
    setBusy(true);
    setFeedback("正在准备独立脚本文件…");
    try {
      await onInsert(selected.id);
      if (live.current && latestScope.current === insertionScope) {
        setConfirming(false);
        setFeedback("样例已交给脚本编辑器，请在那里修改并运行。");
      }
    } catch (reason) {
      if (live.current && latestScope.current === insertionScope) setFeedback(reason instanceof Error ? reason.message : "新增失败，请重试。");
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
  }

  return <section className="docs-sdk-examples" aria-label="可运行样例">
    <nav className="docs-sdk-example-list" aria-label="选择 SDK 样例">
      {SDK_EXAMPLES.map((example, index) => <button key={example.id} type="button" aria-pressed={example.id === selectedId} disabled={busy} onClick={() => {
        setSelectedId(example.id); setConfirming(false); setFeedback("");
      }}>
        <span className="docs-sdk-example-number">0{index + 1}</span>
        <span><strong>{example.title}</strong><small>{example.summary}</small></span>
        {example.id === selectedId && <Check size={15} aria-hidden="true" />}
      </button>)}
    </nav>
    <div className="docs-sdk-example-detail" aria-busy={busy}>
      <header><span><Code2 size={14} />Worker · API 1.0</span><h2>{selected.title}</h2><p>{selected.summary}</p></header>
      <dl className="docs-sdk-example-facts">
        <div><dt>运行上下文</dt><dd>{selected.context}</dd></div>
        <div><dt>预期结果</dt><dd>{selected.expectedResult}</dd></div>
        <div><dt>修改建议</dt><dd>{selected.editHint}</dd></div>
        <div><dt>所需权限</dt><dd>{selected.permissions.length ? selected.permissions.join(" · ") : "无需额外权限"}</dd></div>
      </dl>
      <details className="docs-sdk-example-api"><summary>查看可用 API 与声明</summary>
        <ul>{selected.apis.map(api => <li key={api}><code>{api}</code></li>)}</ul>
        <p>能力：{selected.capabilities.join(" · ")}</p>
        <p>生命周期：{selected.lifecycle.join(" · ")}</p>
      </details>
      <div className="docs-sdk-example-action">
        {confirming ? <div className="docs-sdk-example-confirm" role="group" aria-label="确认新增脚本">
          <strong>新增到 {context.projectName || context.projectId}</strong>
          <p>{selected.fileName} · 同名文件自动编号。已有文件与草稿由编辑器保留。</p>
          <div><button type="button" className="docs-sdk-primary" disabled={busy || Boolean(unavailableReason)} onClick={() => void insert()}><FilePlus2 size={15} />{busy ? "正在新增…" : "确认新增"}</button>
            <button type="button" disabled={busy} onClick={() => { setConfirming(false); setFeedback("已取消新增，当前文件保持不变。"); }}>取消</button></div>
        </div> : <>
          <button className="docs-sdk-primary" type="button" disabled={Boolean(unavailableReason) || busy} title={unavailableReason} onClick={() => { setConfirming(true); setFeedback(""); }}><FilePlus2 size={15} />在脚本编辑器中新增<ArrowUpRight size={14} /></button>
          <p>仅新增独立文件，不会自动运行或发布。</p>
        </>}
        {unavailableReason && <p className="docs-sdk-example-unavailable">{unavailableReason}</p>}
        <div className="docs-sdk-example-feedback" role="status" aria-live="polite">{feedback}</div>
      </div>
      <DocsCenterCodeBlock language="js" value={selected.code} />
    </div>
  </section>;
}
