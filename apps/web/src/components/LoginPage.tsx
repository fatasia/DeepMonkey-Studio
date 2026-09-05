import { useRef, useState } from "react";
import { KeyRound, LoaderCircle } from "lucide-react";
import type {
  SystemBrandingSettings,
  SystemUserRecord,
} from "@bim-studio/contracts";
import { api, setAuthToken } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { loginErrorMessage } from "./loginErrorMessage";

export function LoginPage({
  branding,
  locale,
  onLogin,
}: {
  branding: SystemBrandingSettings;
  locale: AppLocale;
  onLogin: (user: SystemUserRecord) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  async function submit() {
    if (!username.trim() || !password || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.login(username.trim(), password, remember);
      setAuthToken(result.token, remember);
      onLogin(result.user);
    } catch (reason) {
      setError(loginErrorMessage(reason, locale));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-card">
        <h1 className="login-brand" aria-label={branding.systemName}>
          <img src={branding.logoUrl} alt="" />
        </h1>
        {branding.loginSubtitle && <p>{branding.loginSubtitle}</p>}
        {branding.maintenanceEnabled && (
          <aside>{branding.maintenanceMessage}</aside>
        )}
        <label>
          <span>{tr(locale, "用户名", "Username")}</span>
          <input
            aria-label={tr(locale, "用户名", "Username")}
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void submit()}
          />
        </label>
        <label>
          <span>{tr(locale, "密码", "Password")}</span>
          <input
            aria-label={tr(locale, "密码", "Password")}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void submit()}
          />
        </label>
        <label className="login-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span>{tr(locale, "下次自动登录", "Remember me")}</span>
        </label>
        {error && <em role="alert">{error}</em>}
        <button
          disabled={busy || !username.trim() || !password}
          onClick={() => void submit()}
        >
          {busy ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <KeyRound size={15} />
          )}
          {tr(locale, "登录", "Sign in")}
        </button>
        <footer>{branding.copyright}</footer>
      </section>
    </main>
  );
}
