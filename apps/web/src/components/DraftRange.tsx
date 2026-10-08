import { useEffect, useRef, useState } from "react";
import { DeferredNumberInput } from "./AppFormControls";

/** Thumb and readout stay local; engine previews can run without updating the application shell. */
export function DraftRange({ value, min, max, step, disabled = false, label, onChange, onPreview, format,
  numeric = false, numericLabel = label, numericClassName = "material-scalar-value", numericMin = min,
  numericMax = max, readout = true, className }: {
  value: number; min: number; max: number; step: number; disabled?: boolean;
  label: string; onChange: (value: number) => void; onPreview?: ((value: number) => void) | undefined;
  format?: ((value: number) => string) | undefined; numeric?: boolean; numericLabel?: string; className?: string;
  numericClassName?: string; numericMin?: number; numericMax?: number; readout?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const active = useRef<{ initial: number; latest: number; commit: (value: number) => void;
    preview: ((value: number) => void) | undefined; published: number } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const callbacks = useRef({ onChange, onPreview });
  callbacks.current = { onChange, onPreview };
  const external = useRef(value);
  external.current = value;
  const clearTimer = () => { if (timer.current !== undefined) clearTimeout(timer.current); timer.current = undefined; };
  function finish(cancel = false) {
    clearTimer();
    const session = active.current;
    active.current = undefined;
    if (!session) return;
    const next = cancel ? session.initial : session.latest;
    if (session.latest !== session.initial || session.published !== next) session.commit(next);
    setDraft(next);
  }
  useEffect(() => { if (!active.current) setDraft(value); }, [value]);
  useEffect(() => { if (disabled) finish(true); }, [disabled]);
  useEffect(() => () => {
    clearTimer();
    const session = active.current;
    active.current = undefined;
    // Commit to the callback captured for this object, never to a newly selected object.
    if (session && session.latest !== session.initial) session.commit(session.latest);
  }, []);
  function update(next: number) {
    if (disabled || !Number.isFinite(next)) return;
    next = Math.min(max, Math.max(min, next));
    const session = active.current ??= { initial: external.current, latest: external.current,
      published: external.current, commit: callbacks.current.onChange, preview: callbacks.current.onPreview };
    session.latest = next;
    setDraft(next);
    if (session.preview) { session.preview(next); session.published = next; }
    else if (timer.current === undefined) {
      timer.current = setTimeout(() => {
        timer.current = undefined;
        if (active.current !== session) return;
        session.commit(session.latest);
        session.published = session.latest;
      }, 100);
    }
  }
  return <>
    <input className={className} type="range" aria-label={label} disabled={disabled}
      min={min} max={max} step={step} value={draft} onChange={event => update(event.currentTarget.valueAsNumber)}
      onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onBlur={() => finish()}
      onKeyUp={event => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) finish(); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); finish(true); }
        if (event.key === "Enter") { finish(); event.currentTarget.blur(); }
      }} />
    {numeric ? <DeferredNumberInput className={numericClassName} ariaLabel={numericLabel}
      disabled={disabled} value={draft} min={numericMin} max={numericMax} step={step}
      onCommit={next => { finish(); setDraft(next); callbacks.current.onChange(next); }} />
      : readout ? <output>{format ? format(draft) : draft.toFixed(step >= 1 ? 0 : 2)}</output> : null}
  </>;
}
