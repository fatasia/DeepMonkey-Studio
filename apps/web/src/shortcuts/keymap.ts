import { RENDERER_BACKEND_STORAGE_KEY } from "../appDefaults";

export const SHORTCUTS_STORAGE_KEY = "bim-studio.shortcuts";

/** 编辑器工具动作注册表:动作 id → 默认键位(小写主键;修饰符前缀 ctrl-/meta-/shift-/alt-)。 */
export const DEFAULT_SHORTCUTS = Object.freeze({
  "tool.select": "q",
  "tool.translate": "w",
  "tool.rotate": "e",
  "tool.scale": "r",
  "camera.focus": "f",
  "view.toggleGrid": "g",
  "scene.undo": "ctrl+z",
  "scene.redo": "ctrl+y",
});

export type ShortcutAction = keyof typeof DEFAULT_SHORTCUTS;
export const SHORTCUT_ACTIONS = Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[];

export type ShortcutOverrides = Partial<Record<ShortcutAction, string>>;

export function readShortcutOverrides(storage: { getItem(key: string): string | null }): ShortcutOverrides {
  try {
    const raw = storage.getItem(SHORTCUTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Record<string, string>>;
    const out: ShortcutOverrides = {};
    for (const action of SHORTCUT_ACTIONS) {
      const binding = parsed[action];
      if (typeof binding === "string" && binding.length > 0) out[action] = binding;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeShortcutOverrides(storage: { setItem(key: string, value: string): void }, overrides: ShortcutOverrides): void {
  storage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(overrides));
}

/** 动作的有效键位:用户覆盖优先,否则默认。 */
export function effectiveShortcut(action: ShortcutAction, overrides: ShortcutOverrides): string {
  return overrides[action] ?? DEFAULT_SHORTCUTS[action];
}

/** 键盘事件 → 规范化键位串(与键位表同构:ctrl-/meta-/shift-/alt- 前缀 + 小写主键)。 */
export function eventBinding(event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; key: string }): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("ctrl-");
  if (event.metaKey) parts.push("meta-");
  if (event.shiftKey) parts.push("shift-");
  if (event.altKey) parts.push("alt-");
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return parts.join("") + key;
}

/** 输入控件聚焦时不分发(文本输入、数字输入、下拉与代码编辑器保留原生键)。 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable === true;
}
