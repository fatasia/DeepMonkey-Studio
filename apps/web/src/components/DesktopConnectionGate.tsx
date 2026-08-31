import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { NamedServerProfile, ServerHandshakeResult } from "@bim-studio/server-sdk";
import { CheckCircle2, Cloud, HardDrive, LoaderCircle, MonitorCog, RefreshCw, Server, ShieldCheck, WifiOff } from "lucide-react";
import { connectDesktopServer, currentDesktopRuntimeMode, hydrateDesktopServer, isDesktopRuntime, selectDesktopRuntimeMode } from "../adapters/runtimeHost.js";
import "./DesktopConnectionGate.css";

type GateState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "choose"; profile?: NamedServerProfile; handshake?: ServerHandshakeResult }
  | { status: "configure"; profile?: NamedServerProfile; handshake?: ServerHandshakeResult };

export function DesktopConnectionGate({ children }: { children: ReactNode }) {
  const desktop = isDesktopRuntime();
  const [state, setState] = useState<GateState>(() => desktop ? { status: "loading" } : { status: "ready" });

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void hydrateDesktopServer()
      .then(({ profile, handshake }) => {
        if (!active) return;
        const mode = currentDesktopRuntimeMode();
        if (mode === "local") setState({ status: "ready" });
        else if (handshake?.status === "connected") setState({ status: "ready" });
        else setState({ status: mode === "server" ? "configure" : "choose", ...(profile ? { profile } : {}), ...(handshake ? { handshake } : {}) });
      })
      .catch((error) => {
        if (!active) return;
        setState({ status: currentDesktopRuntimeMode() === "server" ? "configure" : "choose", handshake: unreachableHandshake(error) });
      });
    return () => { active = false; };
  }, [desktop]);

  if (state.status === "ready") return children;
  if (state.status === "loading") return <DesktopLoading />;
  if (state.status === "choose") return <DesktopModeChooser state={state} onLocal={() => {
    selectDesktopRuntimeMode("local");
    setState({ status: "ready" });
  }} onServer={() => setState({ status: "configure", ...(state.profile ? { profile: state.profile } : {}), ...(state.handshake ? { handshake: state.handshake } : {}) })} />;
  return <DesktopServerWizard state={state} onConnected={() => setState({ status: "ready" })} />;
}

function DesktopLoading() {
  return <main className="desktop-gate"><section className="desktop-gate-card desktop-gate-loading"><LoaderCircle className="desktop-gate-spinner" /><strong>正在打开 Industrial Studio</strong><span>恢复上次使用的本地或在线工作方式…</span></section></main>;
}

function DesktopModeChooser({ state, onLocal, onServer }: {
  state: Extract<GateState, { status: "choose" }>;
  onLocal: () => void;
  onServer: () => void;
}) {
  return <main className="desktop-gate">
    <section className="desktop-gate-card desktop-mode-card">
      <header className="desktop-gate-header">
        <span className="desktop-gate-mark"><MonitorCog size={24} /></span>
        <span><small>INDUSTRIAL STUDIO DESKTOP</small><strong>选择工作方式</strong></span>
      </header>
      <p className="desktop-gate-intro">不填写服务地址也能完整开始设计。需要团队协作、工业 AI 或在线发布时，再连接企业服务器。</p>
      <div className="desktop-mode-options">
        <button className="desktop-mode-option desktop-mode-primary" onClick={onLocal}>
          <span className="desktop-mode-icon"><HardDrive size={22} /></span>
          <span><strong>本地工作台</strong><small>项目、2D、3D 与脚本保存在本机；可导出单文件包，之后上传到服务器发布。</small></span>
          <em>无需 IP · 推荐首次使用</em>
        </button>
        <button className="desktop-mode-option" onClick={onServer}>
          <span className="desktop-mode-icon"><Cloud size={22} /></span>
          <span><strong>连接企业服务器</strong><small>登录在线项目，使用协作、数据服务、AI、转换与统一发布能力。</small></span>
          <em>{state.profile ? `上次：${state.profile.baseUrl}` : "填写服务 IP 或域名"}</em>
        </button>
      </div>
      {state.handshake && state.handshake.status !== "connected" && <p className="desktop-mode-note"><WifiOff size={15} />上次服务器当前不可用，本地工作台仍可正常使用。</p>}
      <footer>工作方式可在系统菜单中切换；本地工作台不会伪造云端、AI 或现场数据结果。</footer>
    </section>
  </main>;
}

function DesktopServerWizard({ state, onConnected }: {
  state: Extract<GateState, { status: "configure" }>;
  onConnected: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(state.profile?.baseUrl ?? "http://127.0.0.1:4100");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ServerHandshakeResult | undefined>(state.handshake);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setResult(undefined);
    try {
      const next = await connectDesktopServer({
        id: "primary",
        name: "主服务器",
        baseUrl,
        ...(state.profile?.expectedServerInstanceId
          ? { expectedServerInstanceId: state.profile.expectedServerInstanceId }
          : {})
      });
      setResult(next);
      if (next.status === "connected") {
        selectDesktopRuntimeMode("server");
        onConnected();
      }
    } catch (error) {
      setResult(unreachableHandshake(error, baseUrl));
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="desktop-gate">
    <section className="desktop-gate-card">
      <header className="desktop-gate-header">
        <span className="desktop-gate-mark"><MonitorCog size={24} /></span>
        <span><small>INDUSTRIAL STUDIO DESKTOP</small><strong>连接你的服务器</strong></span>
      </header>
      <p className="desktop-gate-intro">客户端只保存一个主服务器配置。IP 或端口变化时，在这里修改；项目、账户和发布版本仍由同一服务器统一管理。</p>
      <div className="desktop-gate-trust">
        <span><ShieldCheck size={17} />校验实例 ID</span>
        <span><CheckCircle2 size={17} />本地打包前端</span>
        <span><Server size={17} />不保存数据源密码</span>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="desktop-server-url">服务器地址</label>
        <div className="desktop-gate-field">
          <Server size={18} />
          <input id="desktop-server-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://192.168.1.20:4100" autoFocus spellCheck={false} />
        </div>
        {result && result.status !== "connected" && <HandshakeFailure result={result} />}
        <button type="submit" disabled={submitting || !baseUrl.trim()}>
          {submitting ? <LoaderCircle className="desktop-gate-spinner" /> : <RefreshCw size={17} />}
          {submitting ? "正在验证…" : "验证并连接"}
        </button>
      </form>
      <footer>登录令牌当前仅保存在客户端运行内存中；安全持久凭据将在 M7 凭据适配器验收后开放。</footer>
    </section>
  </main>;
}

function HandshakeFailure({ result }: { result: Exclude<ServerHandshakeResult, { status: "connected" }> }) {
  const message = result.status === "instance-mismatch"
    ? `该地址对应另一台服务器（当前 ${result.meta.serverInstanceId}，期望 ${result.expectedServerInstanceId}）。请核对 IP/端口，避免发布到错误实例。`
    : result.status === "api-incompatible"
      ? `服务器 API ${result.meta.apiVersion} 与客户端要求的 ${result.expectedApiVersion} 不兼容。`
      : result.message;
  return <div className="desktop-gate-error"><WifiOff size={18} /><span><strong>连接未通过</strong>{message}</span></div>;
}

function unreachableHandshake(error: unknown, baseUrl = "http://127.0.0.1:4100"): ServerHandshakeResult {
  return {
    status: "unreachable",
    profile: { id: "primary", name: "主服务器", baseUrl },
    message: error instanceof Error ? error.message : String(error)
  };
}
