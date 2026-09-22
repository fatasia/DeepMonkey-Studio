import { useState } from "react";
import { Pencil, Plus, Save, Trash2 } from "lucide-react";
import type { ProjectRecord, SystemUserRecord, SystemUserRole } from "@bim-studio/contracts";
import { api } from "../api";
type Translate = (zh: string, en: string) => string;

export function UserPanel({
  t,
  users,
  projects,
  currentUser,
  editing,
  setEditing,
  onReload,
  onError,
}: {
  t: Translate;
  users: SystemUserRecord[];
  projects: ProjectRecord[];
  currentUser: SystemUserRecord;
  editing: SystemUserRecord | "new" | undefined;
  setEditing: (value?: SystemUserRecord | "new") => void;
  onReload: () => Promise<void>;
  onError: (value: string) => void;
}) {
  async function remove(user: SystemUserRecord) {
    if (!confirm(t(`删除用户“${user.displayName}”？`, `Delete user “${user.displayName}”?`))) return;
    try {
      await api.deleteUser(user.id);
      await onReload();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return (
    <div className="system-users">
      <header>
        <div>
          <strong>{t("用户与项目授权", "Users and project access")}</strong>
          <span>{t("管理员、编辑者、浏览者三种角色", "Admin, editor and viewer roles")}</span>
        </div>
        <button onClick={() => setEditing("new")}>
          <Plus size={14} />
          {t("新建用户", "New user")}
        </button>
      </header>
      {editing && (
        <UserForm
          t={t}
          initial={editing === "new" ? undefined : editing}
          projects={projects}
          onCancel={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined);
            await onReload();
          }}
          onError={onError}
        />
      )}
      <div className="system-user-grid">
        {users.map((user) => (
          <article key={user.id}>
            <div className={`system-user-avatar role-${user.role}`}>{user.displayName.slice(0, 1).toUpperCase()}</div>
            <span>
              <strong>
                {user.displayName}
                {user.id === currentUser.id && <i>{t("当前", "Current")}</i>}
              </strong>
              <small>
                @{user.username} · {roleName(t, user.role)}
              </small>
              <em>{user.role === "admin" ? t("全部项目", "All projects") : t(`${user.projectIds.length} 个项目`, `${user.projectIds.length} projects`)}</em>
            </span>
            <i className={user.enabled ? "enabled" : "disabled"}>{user.enabled ? t("启用", "Enabled") : t("停用", "Disabled")}</i>
            <button aria-label={t("编辑", "Edit")} onClick={() => setEditing(user)}>
              <Pencil size={13} />
            </button>
            <button aria-label={t("删除", "Delete")} disabled={user.id === currentUser.id} onClick={() => void remove(user)}>
              <Trash2 size={13} />
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}

function UserForm({
  t,
  initial,
  projects,
  onCancel,
  onSaved,
  onError,
}: {
  t: Translate;
  initial: SystemUserRecord | undefined;
  projects: ProjectRecord[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onError: (value: string) => void;
}) {
  const [username, setUsername] = useState(initial?.username ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<SystemUserRole>(initial?.role ?? "editor");
  const [projectIds, setProjectIds] = useState(initial?.projectIds ?? []);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  async function save() {
    try {
      if (initial) await api.updateUser(initial.id, { displayName, role, projectIds, enabled, ...(password ? { password } : {}) });
      else await api.createUser({ username, displayName, role, projectIds, enabled, password });
      await onSaved();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return (
    <div className="system-user-form">
      <header>
        <strong>{initial ? t("编辑用户", "Edit user") : t("新建用户", "New user")}</strong>
        <button onClick={onCancel}>×</button>
      </header>
      <label>
        <span>{t("用户名", "Username")}</span>
        <input disabled={Boolean(initial)} value={username} onChange={(event) => setUsername(event.target.value)} />
      </label>
      <label>
        <span>{t("显示名称", "Display name")}</span>
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </label>
      <label>
        <span>{initial ? t("新密码（留空不修改）", "New password (leave blank to keep)") : t("初始密码", "Initial password")}</span>
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <label>
        <span>{t("角色", "Role")}</span>
        <select value={role} onChange={(event) => setRole(event.target.value as SystemUserRole)}>
          <option value="admin">{t("管理员", "Admin")}</option>
          <option value="editor">{t("编辑者", "Editor")}</option>
          <option value="viewer">{t("浏览者", "Viewer")}</option>
        </select>
      </label>
      {role !== "admin" && (
        <fieldset>
          <legend>{t("可访问项目", "Accessible projects")}</legend>
          {projects.map((project) => (
            <label key={project.id}>
              <input
                type="checkbox"
                checked={projectIds.includes(project.id)}
                onChange={(event) => setProjectIds((items) => (event.target.checked ? [...items, project.id] : items.filter((id) => id !== project.id)))}
              />
              {project.name}
            </label>
          ))}
        </fieldset>
      )}
      <label className="system-user-enabled">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        {t("启用用户", "Enable user")}
      </label>
      <footer>
        <button onClick={onCancel}>{t("取消", "Cancel")}</button>
        <button className="primary" disabled={!displayName.trim() || (!initial && (!username.trim() || !password))} onClick={() => void save()}>
          <Save size={13} />
          {t("保存", "Save")}
        </button>
      </footer>
    </div>
  );
}

function roleName(t: Translate, role: SystemUserRole) {
  return role === "admin" ? t("管理员", "Admin") : role === "viewer" ? t("浏览者", "Viewer") : t("编辑者", "Editor");
}
