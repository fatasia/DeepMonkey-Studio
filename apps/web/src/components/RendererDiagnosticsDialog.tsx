import { useEffect, useRef, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { RendererDiagnosticsPanel } from "./RendererDiagnosticsPanel";
import { translate as tr } from "../i18n";
import "./RendererDiagnosticsDialog.css";

export function RendererDiagnosticsDialog(props: ComponentProps<typeof RendererDiagnosticsPanel>) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <dialog ref={ref} className="renderer-diagnostics-dialog" aria-label={tr(props.locale, "渲染与诊断", "Rendering & diagnostics")}
      onCancel={event => { event.preventDefault(); props.onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}>
      <RendererDiagnosticsPanel {...props} />
    </dialog>,
    document.querySelector(".app-shell") ?? document.body,
  );
}
