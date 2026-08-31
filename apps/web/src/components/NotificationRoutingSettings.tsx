import { BellRing, Clock3, Plus } from "lucide-react";
import { useState } from "react";
import type {
  NotificationChannelView,
  NotificationRecipientView,
  NotificationRuleSaveRequest,
  NotificationRuleView,
  NotificationSeverity,
  NotificationTemplateView,
} from "./notificationAdministrationModel";
import { NOTIFICATION_SEVERITY_LABELS } from "./notificationAdministrationModel";

interface Props {
  channels: readonly NotificationChannelView[];
  recipients: readonly NotificationRecipientView[];
  rules: readonly NotificationRuleView[];
  templates: readonly NotificationTemplateView[];
  canSave: boolean;
  onSaveRule: (value: NotificationRuleSaveRequest) => void;
  t: (zh: string, en: string) => string;
}

export function NotificationRoutingSettings({
  channels,
  recipients,
  rules,
  templates,
  canSave,
  onSaveRule,
  t,
}: Props) {
  const [editingId, setEditingId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const editing = rules.find((rule) => rule.id === editingId);
  const close = () => {
    setEditingId(undefined);
    setCreating(false);
  };

  return <section className="notification-section notification-rules">
    <header>
      <span>
        <BellRing size={17} />
        <strong>{t("通知规则", "Notification rules")}</strong>
      </span>
      <span>
        <small>{t("事件、渠道、目标与静默时段在一条规则内闭环。", "Each rule connects an event, channels, targets and quiet hours.")}</small>
        <button disabled={!canSave || !templates.length} onClick={() => setCreating(true)}>
          <Plus size={13} />{t("添加规则", "Add rule")}
        </button>
      </span>
    </header>
    <div className="notification-rule-list">
      {rules.map((rule) => <article key={rule.id}>
        <span>
          <strong>{rule.name}</strong>
          <small>{rule.templateName} · {rule.targetNames.join("、") || t("全部范围", "All scope")}</small>
        </span>
        <b className={rule.severity}>{severity(rule.severity, t)}</b>
        <em>{rule.channelIds.length} {t("个渠道", "channels")}</em>
        {rule.quietHours
          ? <em><Clock3 size={12} />{rule.quietHours.start}–{rule.quietHours.end}</em>
          : <em>{t("无静默", "No quiet hours")}</em>}
        <button disabled={!canSave} onClick={() => setEditingId(rule.id)}>
          {t("编辑", "Edit")}
        </button>
      </article>)}
      {!rules.length && <div className="notification-empty">
        {t("暂无通知规则；从一条严重告警开始。", "No rules yet. Start with one critical alert.")}
      </div>}
    </div>
    {(editing || creating) && <RuleEditor
      channels={channels}
      recipients={recipients}
      templates={templates}
      rule={editing ?? newRule(templates[0])}
      create={creating}
      onCancel={close}
      onSave={(value) => {
        onSaveRule(value);
        close();
      }}
      t={t}
    />}
  </section>;
}

function RuleEditor({ channels, recipients, templates, rule, create, onCancel, onSave, t }: {
  channels: readonly NotificationChannelView[];
  recipients: readonly NotificationRecipientView[];
  templates: readonly NotificationTemplateView[];
  rule: NotificationRuleView;
  create: boolean;
  onCancel: () => void;
  onSave: (value: NotificationRuleSaveRequest) => void;
  t: Props["t"];
}) {
  const [eventType, setEventType] = useState(rule.eventType);
  const [severityValue, setSeverity] = useState(rule.severity);
  const [recipientIds, setRecipientIds] = useState(rule.recipientIds);
  const [channelIds, setChannelIds] = useState(rule.channelIds);
  const [templateId, setTemplateId] = useState(rule.templateId);
  const [quietEnabled, setQuietEnabled] = useState(Boolean(rule.quietHours));
  const [start, setStart] = useState(rule.quietHours?.start ?? "22:00");
  const [end, setEnd] = useState(rule.quietHours?.end ?? "07:00");
  const template = templates.find((item) => item.id === templateId);
  const missingRecipients = recipientIds.filter(
    (id) => !recipients.some((item) => item.id === id),
  );
  const missingChannels = channelIds.filter(
    (id) => !channels.some((item) => item.id === id),
  );
  const { quietHours: _previousQuietHours, ...ruleWithoutQuietHours } = rule;

  return <form className="notification-rule-editor" onSubmit={(event) => {
    event.preventDefault();
    onSave({
      rule: {
        ...ruleWithoutQuietHours,
        id: create ? `rule-${Date.now()}` : rule.id,
        name: eventType.trim(),
        eventType: eventType.trim(),
        severity: severityValue,
        recipientIds,
        channelIds,
        templateId,
        templateName: template?.title ?? rule.templateName,
        ...(quietEnabled ? {
          quietHours: { start, end, timezone: rule.quietHours?.timezone ?? "Asia/Shanghai" },
        } : {}),
      },
      ...(create ? { create: true } : {}),
    });
  }}>
    <strong>{create ? t("添加规则", "Add rule") : `${t("编辑规则", "Edit rule")} · ${rule.name}`}</strong>
    <label>
      <span>{t("事件类型", "Event type")}</span>
      <input
        value={eventType}
        placeholder="equipment.failure"
        onChange={(event) => setEventType(event.target.value)}
      />
    </label>
    <label>
      <span>{t("严重度", "Severity")}</span>
      <select
        value={severityValue}
        onChange={(event) => setSeverity(event.target.value as NotificationSeverity)}
      >
        {Object.keys(NOTIFICATION_SEVERITY_LABELS).map((value) => <option key={value} value={value}>
          {severity(value as NotificationSeverity, t)}
        </option>)}
      </select>
    </label>
    <label>
      <span>{t("通知模板", "Template")}</span>
      <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
        {templates.map((item) => <option key={item.id} value={item.id}>
          {item.title} · {item.format}
        </option>)}
      </select>
    </label>
    <CheckList
      title={t("投递渠道", "Delivery channels")}
      values={channels.map((item) => ({ id: item.id, label: item.name }))}
      selected={channelIds}
      missing={missingChannels}
      onChange={setChannelIds}
      t={t}
    />
    <CheckList
      title={t("通知目标", "Notification targets")}
      values={recipients.map((item) => ({ id: item.id, label: item.name }))}
      selected={recipientIds}
      missing={missingRecipients}
      onChange={setRecipientIds}
      t={t}
    />
    <label className="notification-toggle">
      <input
        type="checkbox"
        checked={quietEnabled}
        onChange={(event) => setQuietEnabled(event.target.checked)}
      />
      {t("设置静默时段", "Set quiet hours")}
    </label>
    {quietEnabled && <div className="notification-time-range">
      <label>
        <span>{t("开始", "Start")}</span>
        <input type="time" value={start} onChange={(event) => setStart(event.target.value)} />
      </label>
      <label>
        <span>{t("结束", "End")}</span>
        <input type="time" value={end} onChange={(event) => setEnd(event.target.value)} />
      </label>
    </div>}
    <footer>
      <button type="button" onClick={onCancel}>{t("取消", "Cancel")}</button>
      <button
        className="primary"
        disabled={!eventType.trim()
          || !recipientIds.length
          || !channelIds.length
          || !templateId
          || Boolean(missingRecipients.length || missingChannels.length)}
      >
        {t("保存规则", "Save rule")}
      </button>
    </footer>
  </form>;
}

function CheckList({ title, values, selected, missing, onChange, t }: {
  title: string;
  values: readonly { id: string; label: string }[];
  selected: string[];
  missing: string[];
  onChange: (ids: string[]) => void;
  t: Props["t"];
}) {
  const toggle = (id: string, checked: boolean) => onChange(
    checked ? [...selected, id] : selected.filter((item) => item !== id),
  );
  return <fieldset>
    <legend>{title}</legend>
    {values.map((item) => <label key={item.id}>
      <input
        type="checkbox"
        checked={selected.includes(item.id)}
        onChange={(event) => toggle(item.id, event.target.checked)}
      />
      {item.label}
    </label>)}
    {missing.map((id) => <label className="notification-editor-warning" key={id}>
      <input type="checkbox" checked onChange={() => toggle(id, false)} />
      {t("失效引用", "Missing reference")} · {id}
    </label>)}
  </fieldset>;
}

function severity(value: NotificationSeverity, t: Props["t"]) {
  const [zh, en] = NOTIFICATION_SEVERITY_LABELS[value];
  return t(zh, en);
}

function newRule(template: NotificationTemplateView | undefined): NotificationRuleView {
  return {
    id: "new",
    name: "",
    eventType: "",
    enabled: true,
    severity: "critical",
    recipientIds: [],
    channelIds: [],
    templateId: template?.id ?? "",
    templateName: template?.title ?? "",
    targetNames: [],
  };
}
