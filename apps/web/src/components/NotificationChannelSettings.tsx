import { useCallback, useState, type FormEvent } from "react";
import { CheckCircle2, Mail, Plus, RadioTower, Send, ShieldCheck, Webhook, XCircle } from "lucide-react";
import type { NotificationCredential } from "@bim-studio/contracts";
import type {
  NotificationChannelKind,
  NotificationChannelSaveRequest,
  NotificationChannelView,
} from "./notificationAdministrationModel";
import { NOTIFICATION_CHANNEL_LABELS } from "./notificationAdministrationModel";
import { notificationChannelReady } from "./notificationAdministrationModel";
import { NotificationCredentialFields } from "./NotificationCredentialFields";

interface Props {
  channels: readonly NotificationChannelView[];
  busyChannelId?: string;
  canConfigure: boolean;
  canTest: boolean;
  onSave: (value: NotificationChannelSaveRequest) => void;
  onTest: (channelId: string) => void;
  t: (zh: string, en: string) => string;
}

export function NotificationChannelSettings({ channels, busyChannelId, canConfigure, canTest, onSave, onTest, t }: Props) {
  const [editingId, setEditingId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const editing = channels.find((channel) => channel.id === editingId);
  return (
    <section className="notification-section notification-channels">
      <header>
        <span><RadioTower size={17} /><strong>{t("投递渠道", "Delivery channels")}</strong></span>
        <span>
          <small>{t("凭据只可写入；已配置状态不回显密钥。", "Credentials are write-only; configured state never reveals a secret.")}</small>
          <button disabled={!canConfigure} onClick={() => setCreating(true)}>
            <Plus size={13} />{t("添加渠道", "Add channel")}
          </button>
        </span>
      </header>
      <div className="notification-channel-grid">
        {channels.map((channel) => (
          <article key={channel.id} className={channel.enabled ? "enabled" : "disabled"}>
            <div className="notification-channel-icon">{channelIcon(channel.kind)}</div>
            <div>
              <strong>{channel.name}</strong>
              <small>{label(channel.kind, t)} · {channel.endpointHint ?? t("未设置目标", "No endpoint set")}</small>
              {channel.kind !== "smtp" && channel.kind !== "webhook" && <small className="notification-channel-scope">{t("群机器人用于群通知；企业应用用于个人/部门。", "Group bots notify groups; enterprise apps reach people or departments.")}</small>}
              <em className={notificationChannelReady(channel) ? "configured" : "missing"}>
                <ShieldCheck size={12} />{channelStatus(channel, t)}
              </em>
            </div>
            <i>{channel.enabled ? t("启用", "Enabled") : t("停用", "Disabled")}</i>
            <footer>
              <button disabled={Boolean(busyChannelId) || !canConfigure} onClick={() => setEditingId(channel.id)}>{t("配置", "Configure")}</button>
              <button disabled={Boolean(busyChannelId) || !canTest || !channel.enabled || !notificationChannelReady(channel)} onClick={() => onTest(channel.id)}>
                <Send size={13} />{busyChannelId === channel.id ? t("测试中", "Testing") : t("测试发送", "Send test")}
              </button>
            </footer>
            {channel.lastTest && <p className={channel.lastTest.status}><span>{channel.lastTest.status === "passed" ? <CheckCircle2 size={13} /> : <XCircle size={13} />}{channel.lastTest.message}</span><time>{channel.lastTest.at}</time></p>}
          </article>
        ))}
      </div>
      {(editing || creating) && <ChannelEditor
        channel={editing ?? newChannel()}
        create={creating}
        onCancel={() => {
          setEditingId(undefined);
          setCreating(false);
        }}
        onSave={(channel) => {
          onSave(channel);
          setEditingId(undefined);
          setCreating(false);
        }}
        t={t}
      />}
    </section>
  );
}

function ChannelEditor({ channel, create, onCancel, onSave, t }: {
  channel: NotificationChannelView;
  create: boolean;
  onCancel: () => void;
  onSave: (value: NotificationChannelSaveRequest) => void;
  t: Props["t"];
}) {
  const [name, setName] = useState(channel.name);
  const [enabled, setEnabled] = useState(channel.enabled);
  const [endpoint, setEndpoint] = useState("");
  const [kind, setKind] = useState(channel.kind);
  const [deliveryMode, setDeliveryMode] = useState<"bot" | "application">(channel.deliveryMode ?? "bot");
  const [credential, setCredential] = useState<NotificationCredential>();
  const [credentialValid, setCredentialValid] = useState(channel.credentialConfigured);
  const onCredentialChange = useCallback((next: NotificationCredential | undefined, valid: boolean) => {
    setCredential(next);
    setCredentialValid(valid);
  }, []);
  const endpointValue = endpoint.trim();
  const applicationChannel = kind !== "smtp" && kind !== "webhook";
  const requiresEndpoint = kind !== "smtp" && (kind === "webhook" || deliveryMode === "bot");
  const endpointValid = !requiresEndpoint || Boolean(endpointValue) || channel.endpointConfigured;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave({
      channel: {
        ...channel,
        id: create ? `notification-${kind}-${Date.now()}` : channel.id,
        kind,
        name,
        enabled,
        ...(applicationChannel ? { deliveryMode } : {}),
      },
      ...(endpointValue ? { endpoint: endpointValue } : {}),
      ...(credential ? { credential } : {}),
      ...(create ? { create: true } : {}),
    });
  }

  return <form className="notification-channel-editor" onSubmit={submit}>
    <strong>{create ? t("添加渠道", "Add channel") : `${t("配置", "Configure")} · ${channel.name}`}</strong>
    <label>
      <span>{t("显示名称", "Display name")}</span>
      <input value={name} onChange={(event) => setName(event.target.value)} />
    </label>
    {create && <label>
      <span>{t("渠道类型", "Channel type")}</span>
      <select
        aria-label={t("渠道类型", "Channel type")}
        value={kind}
        onChange={(event) => setKind(event.target.value as NotificationChannelKind)}
      >
        {Object.keys(NOTIFICATION_CHANNEL_LABELS).map((value) => <option key={value} value={value}>
          {label(value as NotificationChannelKind, t)}
        </option>)}
      </select>
    </label>}
    {requiresEndpoint && <label>
      <span>{t("地址或机器人标识", "Endpoint or bot ID")}</span>
      <input
        value={endpoint}
        onChange={(event) => setEndpoint(event.target.value)}
        placeholder={channel.endpointHint ?? t("留空保持现有地址", "Blank keeps the existing endpoint")}
      />
    </label>}
    {applicationChannel && <label>
      <span>{t("投递方式", "Delivery mode")}</span>
      <select
        aria-label={t("投递方式", "Delivery mode")}
        value={deliveryMode}
        onChange={(event) => setDeliveryMode(event.target.value as "bot" | "application")}
      >
        <option value="bot">{t("群机器人", "Group bot")}</option>
        <option value="application">{t("企业应用", "Enterprise application")}</option>
      </select>
    </label>}
    <NotificationCredentialFields
      kind={kind}
      deliveryMode={deliveryMode}
      configured={channel.credentialConfigured}
      onChange={onCredentialChange}
      t={t}
    />
    <label className="notification-toggle">
      <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      {t("启用该渠道", "Enable this channel")}
    </label>
    <footer>
      <button type="button" onClick={onCancel}>{t("取消", "Cancel")}</button>
      <button className="primary" disabled={!name.trim() || !credentialValid || !endpointValid}>
        {t("保存渠道", "Save channel")}
      </button>
    </footer>
  </form>;
}

function channelIcon(kind: NotificationChannelKind) {
  if (kind === "smtp") return <Mail size={17} />;
  if (kind === "webhook") return <Webhook size={17} />;
  return <RadioTower size={17} />;
}

function label(kind: NotificationChannelKind, t: Props["t"]) {
  const [zh, en] = NOTIFICATION_CHANNEL_LABELS[kind];
  return t(zh, en);
}

function channelStatus(channel: NotificationChannelView, t: Props["t"]) {
  if (channel.kind === "smtp" || channel.deliveryMode === "application") {
    return channel.credentialConfigured ? t("凭据已配置", "Credential configured") : t("尚未配置凭据", "Credential required");
  }
  if (!channel.endpointConfigured) return t("尚未配置投递地址", "Endpoint required");
  if (channel.kind === "webhook" && channel.credentialConfigured) return t("地址与签名已配置", "Endpoint and signature configured");
  return t("投递地址已配置", "Endpoint configured");
}

function newChannel(): NotificationChannelView {
  return { id: "new", kind: "smtp", name: "", enabled: true, endpointConfigured: false, credentialConfigured: false };
}
