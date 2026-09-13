import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Download, LoaderCircle, Save, Sparkles } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { api } from "../api";
import type { Modeling3dStatus } from "../apiClients/modeling3dApi";
import "./Modeling3dPanel.css";

type ProviderId = "tripo3d" | "tencentHunyuan";

interface Props {
  locale: AppLocale;
  provider?: ProviderId;
  onImport?: (modelUrl: string, provider: ProviderId) => Promise<void> | void;
}

const MODELING_SAMPLES = {
  tripo3d: ["低多边形六轴机械臂，工业灰，PBR 材质", "带法兰和螺栓孔的离心泵", "现代工厂用 AGV 搬运机器人"],
  tencentHunyuan: ["写实风格工业控制柜，双开门", "不锈钢储罐，顶部管口与支腿", "紧凑型协作机器人，白色外壳"],
} satisfies Record<ProviderId, string[]>;

export default function Modeling3dPanel({ locale, provider: fixedProvider, onImport }: Props) {
  const [prompt, setPrompt] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>(fixedProvider ?? "tripo3d");
  const [job, setJob] = useState<Modeling3dStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const provider = fixedProvider ?? selectedProvider;

  useEffect(() => {
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const generate = useCallback(async () => {
    if (prompt.trim().length < 3) return;
    setError(null);
    setJob(null);
    try {
      const result = await api.submit(prompt.trim(), provider);
      if (result.error) { setError(result.error); return; }
      setJob({ taskId: result.taskId, status: result.status, provider: result.provider });
      if (result.status === "running" || result.status === "pending") {
        timerRef.current = setInterval(async () => {
          try {
            const s = await api.poll(result.taskId);
            setJob(s);
            if (s.status === "success" || s.status === "failed") {
              if (timerRef.current) clearInterval(timerRef.current);
              if (s.error) setError(s.error);
            }
          } catch { /* keep polling */ }
        }, 3000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败");
    }
  }, [prompt, provider]);

  const busy = job?.status === "pending" || job?.status === "running";

  return (
    <section className="modeling3d-panel" aria-label={tr(locale, "AI 3D 生成", "AI 3D generation")} aria-busy={busy || undefined}>
      <div className="modeling3d-header">
        <Sparkles size={16} />
        <h4>{provider === "tripo3d" ? "Tripo3D" : tr(locale, "腾讯混元 3D", "Tencent Hunyuan 3D")}</h4>
        {!fixedProvider && <select value={provider} disabled={busy} onChange={(e) => setSelectedProvider(e.target.value as ProviderId)} aria-label={tr(locale, "选择供应商", "Provider")}>
          <option value="tripo3d">Tripo3D</option>
          <option value="tencentHunyuan">{tr(locale, "腾讯混元 3D", "Tencent Hunyuan 3D")}</option>
        </select>}
      </div>
      <textarea
        className="modeling3d-prompt"
        aria-label={tr(locale, "模型生成描述", "Model generation prompt")}
        value={prompt}
        disabled={busy}
        maxLength={2000}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={tr(locale, "描述外形、结构、材质与风格", "Describe shape, structure, material, and style")}
      />
      <div className="modeling3d-samples">
        {MODELING_SAMPLES[provider].map((sample) => <button type="button" key={sample} disabled={busy} onClick={() => setPrompt(sample)}>{sample}</button>)}
      </div>
      <button type="button" className="modeling3d-generate" disabled={busy || prompt.trim().length < 3} onClick={() => void generate()}>
        {busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
        {busy ? tr(locale, "生成中…", "Generating…") : tr(locale, "开始生成", "Generate")}
      </button>
      {error && <p className="modeling3d-error" role="alert">{error}</p>}
      {job?.status === "running" && job.progress != null && (
        <div className="modeling3d-progress" role="progressbar" aria-label={tr(locale, "模型生成进度", "Model generation progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress)}><span style={{ width: Math.round(job.progress) + "%" }} /></div>
      )}
      {job?.status === "success" && job.modelUrl && (
        <div className="modeling3d-result" role="status">
          <span><Box size={14} /> {tr(locale, "生成完成", "Done")}</span>
          <div>
            <a href={job.modelUrl} download><Download size={14} /> GLB</a>
            {onImport && <button type="button" disabled={importing} onClick={async () => {
              setImporting(true); setError(null);
              try { await onImport(job.modelUrl!, provider); }
              catch (reason) { setError(reason instanceof Error ? reason.message : tr(locale, "保存失败", "Save failed")); }
              finally { setImporting(false); }
            }}>{importing ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />}{tr(locale, "保存到资源", "Save to assets")}</button>}
          </div>
        </div>
      )}
      {job?.status === "failed" && <p className="modeling3d-error" role="alert">{job.error || tr(locale, "生成失败", "Generation failed")}</p>}
    </section>
  );
}
