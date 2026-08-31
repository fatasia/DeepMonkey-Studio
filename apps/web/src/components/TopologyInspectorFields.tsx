import { useEffect, useState } from "react";

export function InspectorTextField({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder?: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label>
      <span>{label}</span>
      <input
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

export function InspectorNumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const normalized = String(Math.round(value));
  const [draft, setDraft] = useState(normalized);
  useEffect(() => setDraft(normalized), [normalized]);
  function commit() {
    const next = Number(draft);
    if (Number.isFinite(next) && next !== value) onCommit(next);
    else setDraft(normalized);
  }
  return (
    <label>
      <span>{label}</span>
      <input
        value={draft}
        inputMode="numeric"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(normalized);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

export function InspectorOptionalNumberField({ label, value, onCommit }: { label: string; value: number | undefined; onCommit: (value: number | undefined) => void }) {
  const normalized = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(normalized);
  useEffect(() => setDraft(normalized), [normalized]);
  function commit() {
    if (!draft.trim()) {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const next = Number(draft);
    if (Number.isFinite(next) && next !== value) onCommit(next);
    else setDraft(normalized);
  }
  return (
    <label>
      <span>{label}</span>
      <input
        value={draft}
        inputMode="decimal"
        placeholder="—"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(normalized);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}
