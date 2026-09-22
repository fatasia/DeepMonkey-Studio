import { compileDashboardTextInput } from "./dashboardTextInputCompile";
import type { DashboardRasterCompileInput } from "./dashboardRasterTypes";

/** Each supported filter retains its own editor; targets combine their values in Native. */
export function compileDashboardTextInputs(source: DashboardRasterCompileInput, identities: ReadonlyMap<string,string>) {
  const filters = source.document.application.pages.flatMap(page => page.nodes)
    .filter(node => node.visible !== false && node.kind === "data-widget" && node.widget.type === "filter" && node.widget.filterMode === "text");
  if (!filters.length || filters.length > 16)
    return { reason: "Text input collection requires 1–16 text filters" };
  const inputs = [];
  for (const filter of filters) {
    const document = { ...source.document, application: { ...source.document.application,
      pages: source.document.application.pages.map(page => ({ ...page, nodes: page.nodes.filter(node =>
        node.kind !== "data-widget" || node.widget.type !== "filter" || node.id === filter.id) })) } };
    const result = compileDashboardTextInput({ ...source, document }, identities);
    if (!result.input) return { reason: result.reason ?? "Text filter cannot preserve author semantics" };
    inputs.push(result.input);
  }
  const selectKeys = source.document.application.pages.flatMap(page => page.nodes).filter(node => node.visible !== false && node.kind === "data-widget" && node.widget.type === "filter" && node.widget.filterMode !== "text").map(node => node.kind === "data-widget" ? node.widget.key : "");
  if (new Set(inputs.map(input => input.key)).size !== inputs.length || inputs.some(input => selectKeys.includes(input.key))) return { reason: "Text filter keys must be unique" };
  const bytes = inputs.reduce((sum, input) => sum + input.fonts.reduce((total, font) => total + atob(font.dataBase64).length, 0), 0);
  if (bytes > 32 * 1024 * 1024) return { reason: "Combined text input fonts exceed 32 MiB" };
  return { input: inputs[0]!, inputs };
}
