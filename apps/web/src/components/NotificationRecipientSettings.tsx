import { ContactRound, Pencil, Plus, Trash2, UsersRound } from "lucide-react";
import { useState } from "react";
import type {
  NotificationRecipientSaveRequest,
  NotificationRecipientView,
} from "./notificationAdministrationModel";

interface Props {
  recipients: readonly NotificationRecipientView[];
  busyId?: string;
  canSave: boolean;
  onSave: (value: NotificationRecipientSaveRequest) => void;
  onDelete: (recipientId: string) => void;
  t: (zh: string, en: string) => string;
}

export function NotificationRecipientSettings({
  recipients,
  busyId,
  canSave,
  onSave,
  onDelete,
  t,
}: Props) {
  const [editingId, setEditingId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const editing = recipients.find((item) => item.id === editingId);
  const close = () => {
    setEditingId(undefined);
    setCreating(false);
  };

  return <section className="notification-section notification-recipients">
    <header>
      <span>
        <ContactRound size={17} />
        <strong>{t("收件人目录", "Recipient directory")}</strong>
      </span>
      <span>
        <small>{t("个人、部门与值班组可被规则复用。", "People, departments and on-call groups are reusable rule targets.")}</small>
        <button disabled={!canSave} onClick={() => setCreating(true)}>
          <Plus size={13} />{t("添加收件人", "Add recipient")}
        </button>
      </span>
    </header>
    <div className="notification-recipient-list">
      {recipients.map((recipient) => <article key={recipient.id}>
        <i>{recipient.type === "group"
          ? <UsersRound size={15} />
          : <ContactRound size={15} />}
        </i>
        <span>
          <strong>{recipient.name}</strong>
          <small>{recipient.addressHint}</small>
        </span>
        <em>{recipientKindLabel(recipient, t)}</em>
        <button
          title={t("编辑", "Edit")}
          disabled={Boolean(busyId) || !canSave}
          onClick={() => setEditingId(recipient.id)}
        >
          <Pencil size={13} />
        </button>
        <button
          title={t("删除", "Delete")}
          disabled={Boolean(busyId) || !canSave}
          onClick={() => onDelete(recipient.id)}
        >
          <Trash2 size={13} />
        </button>
      </article>)}
      {!recipients.length && <div className="notification-empty">
        {t("尚未建立收件人目录；先添加个人或值班组。", "No recipients yet. Add a person or on-call group first.")}
      </div>}
    </div>
    {(editing || creating) && <RecipientEditor
      recipient={editing ?? newRecipient()}
      peers={recipients}
      create={creating}
      onCancel={close}
      onSave={(value) => {
        onSave(value);
        close();
      }}
      t={t}
    />}
  </section>;
}

function RecipientEditor({ recipient, peers, create, onCancel, onSave, t }: {
  recipient: NotificationRecipientView;
  peers: readonly NotificationRecipientView[];
  create: boolean;
  onCancel: () => void;
  onSave: (value: NotificationRecipientSaveRequest) => void;
  t: Props["t"];
}) {
  const [type, setType] = useState(recipient.type);
  const [name, setName] = useState(recipient.name);
  const [address, setAddress] = useState(recipient.address ?? "");
  const [platformUserId, setPlatformUserId] = useState(recipient.platformUserId ?? "");
  const [platformTargetType, setPlatformTargetType] = useState(recipient.platformTargetType ?? "open_id");
  const [departmentIds, setDepartmentIds] = useState(recipient.platformDepartmentIds?.join(", ") ?? "");
  const [memberIds, setMemberIds] = useState(recipient.memberIds ?? []);
  const addressReady = type === "group"
    || Boolean(address.trim() || platformUserId.trim() || departmentIds.trim());
  const departments = splitIds(departmentIds);

  return <form className="notification-recipient-editor" onSubmit={(event) => {
    event.preventDefault();
    onSave({
      recipient: {
        ...recipient,
        id: create ? `recipient-${Date.now()}` : recipient.id,
        type,
        name: name.trim(),
        addressHint: address.trim()
          || platformUserId.trim()
          || departmentIds.trim()
          || t("群目标", "Group target"),
        ...(address.trim() ? { address: address.trim() } : {}),
        ...(platformUserId.trim() ? { platformUserId: platformUserId.trim(), platformTargetType } : {}),
        ...(departments.length ? { platformDepartmentIds: departments } : {}),
        ...(type === "group" && memberIds.length ? { memberIds } : {}),
      },
      ...(create ? { create: true } : {}),
    });
  }}>
    <strong>{create ? t("添加收件人", "Add recipient") : `${t("编辑", "Edit")} · ${recipient.name}`}</strong>
    <label>
      <span>{t("类型", "Type")}</span>
      <select value={type} onChange={(event) => setType(event.target.value as NotificationRecipientView["type"])}>
        <option value="person">{t("个人", "Person")}</option>
        <option value="group">{t("组", "Group")}</option>
        <option value="external">{t("外部目标", "External")}</option>
      </select>
    </label>
    <label>
      <span>{t("显示名称", "Display name")}</span>
      <input value={name} onChange={(event) => setName(event.target.value)} />
    </label>
    {type !== "group" && <>
      <label>
        <span>{t("邮箱或外部地址", "Email or external address")}</span>
        <input value={address} onChange={(event) => setAddress(event.target.value)} />
      </label>
      <label>
        <span>{t("平台用户 ID", "Platform user ID")}</span>
        <input value={platformUserId} onChange={(event) => setPlatformUserId(event.target.value)} />
      </label>
      {platformUserId && <label>
        <span>{t("用户 ID 类型", "User ID type")}</span>
        <select
          value={platformTargetType}
          onChange={(event) => setPlatformTargetType(event.target.value as typeof platformTargetType)}
        >
          <option value="open_id">open_id</option>
          <option value="user_id">user_id</option>
          <option value="chat_id">chat_id</option>
        </select>
      </label>}
      <label>
        <span>{t("部门 ID（逗号分隔）", "Department IDs (comma-separated)")}</span>
        <input value={departmentIds} onChange={(event) => setDepartmentIds(event.target.value)} />
      </label>
    </>}
    {type === "group" && <fieldset>
      <legend>{t("组成员（可选）", "Group members (optional)")}</legend>
      {peers
        .filter((item) => item.type !== "group" && item.id !== recipient.id)
        .map((item) => <label key={item.id}>
          <input
            type="checkbox"
            checked={memberIds.includes(item.id)}
            onChange={(event) => setMemberIds((current) => event.target.checked
              ? [...current, item.id]
              : current.filter((id) => id !== item.id))}
          />
          {item.name}
        </label>)}
    </fieldset>}
    <footer>
      <button type="button" onClick={onCancel}>{t("取消", "Cancel")}</button>
      <button className="primary" disabled={!name.trim() || !addressReady}>
        {t("保存收件人", "Save recipient")}
      </button>
    </footer>
  </form>;
}

function recipientKindLabel(recipient: NotificationRecipientView, t: Props["t"]) {
  if (recipient.type === "group") return t(`${recipient.memberCount ?? 0} 人`, `${recipient.memberCount ?? 0} members`);
  return recipient.type === "external" ? t("外部目标", "External") : t("个人", "Person");
}

function splitIds(value: string): string[] {
  return [...new Set(value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean))];
}

function newRecipient(): NotificationRecipientView {
  return { id: "new", type: "person", name: "", addressHint: "" };
}
