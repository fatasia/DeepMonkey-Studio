import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { NamedServerProfile, ServerHandshakeResult } from "@bim-studio/server-sdk";
import { CheckCircle2, LoaderCircle, MonitorCog, RefreshCw, Server, ShieldCheck, WifiOff } from "lucide-react";
import { connectDesktopServer, hydrateDesktopServer, isDesktopRuntime } from "../adapters/runtimeHost.js";
import "./DesktopConnectionGate.css";

type GateState =
  | { status: "loading" }
  | { status: "ready" }
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
        setState(handshake?.status === "connected"
          ? { status: "ready" }
          : { status: "configure", ...(profile ? { profile } : {}), ...(handshake ? { handshake } : {}) });
      })
      .catch((error) => {
        if (!active) return;
        setState({ status: "configure", handshake: unreachableHandshake(error) });
      });
    return () => { active = false; };
  }, [desktop]);

  if (state.status === "ready") return children;
  if (state.status === "loading") return <DesktopLoading />;
  return <DesktopServerWizard state={state} onConnected={() => setState({ status: "ready" })} />;
}

function DesktopLoading() {
  return <main className="desktop-gate"><section className="desktop-gate-card desktop-gate-loading"><LoaderCircle className="desktop-gate-spinner" /><strong>正在连接 iTwin Studio 服务器</strong><span>校验服务器身份与 API 版本…</span></section></main>;
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
      if (next.status === "connected") onConnected();
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
        <span><small>ITWIN STUDIO DESKTOP</small><strong>连接你的服务器</strong></span>
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
