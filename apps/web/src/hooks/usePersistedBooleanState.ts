import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

/** A preference-backed boolean that still behaves like React's native state setter. */
export function usePersistedBooleanState(key: string, fallback: boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [value, setValue] = useState(() => readBooleanPreference(key, fallback));
  const update = useCallback<Dispatch<SetStateAction<boolean>>>((next) => {
    setValue((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      writeBooleanPreference(key, resolved);
      return resolved;
    });
  }, [key]);
  return [value, update];
}

export function writeBooleanPreference(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Restricted webviews can keep the preference for the current session only.
  }
}

export function readBooleanPreference(key: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored !== "false";
  } catch {
    return fallback;
  }
}
