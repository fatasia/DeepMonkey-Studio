import { useEffect, useState } from "react";
import type { NotificationCredential } from "@bim-studio/contracts";
import type { NotificationChannelKind } from "./notificationAdministrationModel";
import { buildCredential, credentialRequired } from "./notificationCredentialDraft";

interface Props {
  kind: NotificationChannelKind;
  deliveryMode?: "bot" | "application";
  configured: boolean;
  onChange: (credential: NotificationCredential | undefined, valid: boolean) => void;
  t: (zh: string, en: string) => string;
}

/**
 * 凭据只保存在此局部表单状态，不能由快照回填。
 * 空字段代表“保留服务端 secretRef”，而不是空覆盖。
 */
export function NotificationCredentialFields({ kind, deliveryMode, configured, onChange, t }: Props) {
  const [smtp, setSmtp] = useState({ host: "", port: "587", from: "", username: "", password: "", secure: false });
  const [lark, setLark] = useState({ appId: "", appSecret: "" });
  const [wecom, setWecom] = useState({ corpId: "", corpSecret: "", agentId: "" });
  const [dingtalk, setDingtalk] = useState({ appKey: "", appSecret: "", agentId: "" });
  const [webhookSecret, setWebhookSecret] = useState("");

  const application = deliveryMode === "application";
  const required = credentialRequired(kind, deliveryMode);
  const credential = buildCredential(kind, application, { smtp, lark, wecom, dingtalk, webhookSecret });
  const valid = !required || Boolean(credential) || configured;

  useEffect(() => {
    onChange(credential, valid);
  }, [credential, onChange, valid]);

  if (kind !== "smtp" && kind !== "webhook" && !application) {
    return <p className="notification-credential-help">{t("群机器人只需填写上方机器人地址；企业应用才需要 App 凭据。", "Group bots only need the endpoint above; application credentials are required for enterprise delivery.")}</p>;
  }

  return <fieldset className="notification-credential-fields">
    <legend>{t("安全凭据", "Secure credential")}</legend>
    <p>{t("已保存字段不会回显；留空代表保留现有凭据。", "Saved values are never shown; blank fields keep the existing credential.")}</p>
    {kind === "smtp" && <SmtpFields value={smtp} onChange={setSmtp} t={t} />}
    {kind === "lark" && <LarkFields value={lark} onChange={setLark} />}
    {kind === "wecom" && <WecomFields value={wecom} onChange={setWecom} />}
    {kind === "dingtalk" && <DingtalkFields value={dingtalk} onChange={setDingtalk} />}
    {kind === "webhook" && <SecretField label={t("签名密钥", "Signing secret")} value={webhookSecret} onChange={setWebhookSecret} />}
    {!valid && <small className="notification-credential-error">{t("请补全该渠道所需凭据，或先保存已有凭据。", "Complete the required credential fields before saving.")}</small>}
  </fieldset>;
}

interface SmtpDraft {
  host: string;
  port: string;
  from: string;
  username: string;
  password: string;
  secure: boolean;
}

interface ApplicationDraft {
  appId: string;
  appSecret: string;
}

interface WecomDraft {
  corpId: string;
  corpSecret: string;
  agentId: string;
}

interface DingtalkDraft {
  appKey: string;
  appSecret: string;
  agentId: string;
}

function SmtpFields({ value, onChange, t }: {
  value: SmtpDraft;
  onChange: (next: SmtpDraft) => void;
  t: Props["t"];
}) {
  return <div className="notification-credential-grid">
    <TextField label={t("SMTP 主机", "SMTP host")} value={value.host} onChange={(host) => onChange({ ...value, host })} />
    <TextField label={t("端口", "Port")} value={value.port} inputMode="numeric" onChange={(port) => onChange({ ...value, port })} />
    <TextField label={t("发件人", "From")} value={value.from} onChange={(from) => onChange({ ...value, from })} />
    <TextField label={t("用户名（可选）", "Username (optional)")} value={value.username} onChange={(username) => onChange({ ...value, username })} />
    <SecretField label={t("密码（可选）", "Password (optional)")} value={value.password} onChange={(password) => onChange({ ...value, password })} />
    <label className="notification-toggle">
      <input
        type="checkbox"
        checked={value.secure}
        onChange={(event) => onChange({ ...value, secure: event.target.checked })}
      />
      {t("启用 TLS", "Use TLS")}
    </label>
  </div>;
}

function LarkFields({ value, onChange }: {
  value: ApplicationDraft;
  onChange: (next: ApplicationDraft) => void;
}) {
  return <div className="notification-credential-grid">
    <TextField label="App ID" value={value.appId} onChange={(appId) => onChange({ ...value, appId })} />
    <SecretField label="App Secret" value={value.appSecret} onChange={(appSecret) => onChange({ ...value, appSecret })} />
  </div>;
}

function WecomFields({ value, onChange }: {
  value: WecomDraft;
  onChange: (next: WecomDraft) => void;
}) {
  return <div className="notification-credential-grid">
    <TextField label="Corp ID" value={value.corpId} onChange={(corpId) => onChange({ ...value, corpId })} />
    <SecretField label="Corp Secret" value={value.corpSecret} onChange={(corpSecret) => onChange({ ...value, corpSecret })} />
    <TextField
      label="Agent ID"
      value={value.agentId}
      inputMode="numeric"
      onChange={(agentId) => onChange({ ...value, agentId })}
    />
  </div>;
}

function DingtalkFields({ value, onChange }: {
  value: DingtalkDraft;
  onChange: (next: DingtalkDraft) => void;
}) {
  return <div className="notification-credential-grid">
    <TextField label="App Key" value={value.appKey} onChange={(appKey) => onChange({ ...value, appKey })} />
    <SecretField label="App Secret" value={value.appSecret} onChange={(appSecret) => onChange({ ...value, appSecret })} />
    <TextField
      label="Agent ID"
      value={value.agentId}
      inputMode="numeric"
      onChange={(agentId) => onChange({ ...value, agentId })}
    />
  </div>;
}

function TextField({ label, value, inputMode, onChange }: {
  label: string;
  value: string;
  inputMode?: "numeric";
  onChange: (value: string) => void;
}) {
  return <label>
    <span>{label}</span>
    <input
      value={value}
      inputMode={inputMode}
      onChange={(event) => onChange(event.target.value)}
    />
  </label>;
}

function SecretField({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return <label>
    <span>{label}</span>
    <input
      type="password"
      autoComplete="new-password"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  </label>;
}
