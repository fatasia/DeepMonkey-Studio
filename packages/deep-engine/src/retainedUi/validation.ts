import { RETAINED_UI_BUDGETS, RETAINED_UI_SCHEMA_VERSION, type RetainedUiDiagnostic, type RetainedUiDiagnosticCode, type RetainedUiNode, type RetainedUiNodeKind, type RetainedUiTree, type RetainedUiValidation } from "./types.js";
type Obj = Record<string, unknown>;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const object = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const dense = (v: unknown): v is unknown[] => Array.isArray(v) && Reflect.ownKeys(v).every((key) => key === "length" || (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key))) && Array.from({ length: v.length }, (_, i) => { const d = Object.getOwnPropertyDescriptor(v, i); return d?.enumerable === true && "value" in d; }).every(Boolean);
function add(out: RetainedUiDiagnostic[], code: RetainedUiDiagnosticCode, path: string, message: string): void { if (out.length < RETAINED_UI_BUDGETS.diagnostics)
  out.push({ code, path, message }); }
function keys(v: Obj, allowed: readonly string[], path: string, out: RetainedUiDiagnostic[]): void { const set = new Set(allowed); for (const key of Object.keys(v))
  if (!set.has(key))
    add(out, "unknown-field", `${path}.${key}`, "Field is not defined by retained UI v1."); }
function validId(v: unknown, path: string, out: RetainedUiDiagnostic[]): v is string { if (typeof v === "string" && ID.test(v) && !["__proto__", "prototype", "constructor"].includes(v))
  return true; add(out, "invalid-value", path, "Expected a stable ASCII id of at most 256 characters."); return false; }
function bounded(v: unknown, path: string, out: RetainedUiDiagnostic[], min: number = -RETAINED_UI_BUDGETS.coordinate, max: number = RETAINED_UI_BUDGETS.coordinate): boolean { if (finite(v) && v >= min && v <= max)
  return true; add(out, "invalid-value", path, `Expected a finite number in [${min}, ${max}].`); return false; }
function color(v: unknown, path: string, out: RetainedUiDiagnostic[]): void {
  if (!dense(v) || v.length !== 4 || v.some((channel) => !finite(channel) || channel < 0 || channel > 1))
    add(out, "invalid-value", path, "Expected four finite RGBA channels in [0, 1].");
}
function json(v: unknown, path: string, out: RetainedUiDiagnostic[], state: {
  values: number;
  strings: number;
}, depth = 0): void {
  if (++state.values > RETAINED_UI_BUDGETS.jsonValues || depth > RETAINED_UI_BUDGETS.jsonDepth) {
    add(out, "budget-exceeded", path, "JSON size or depth budget exceeded.");
    return;
  }
  if (v === null || typeof v === "boolean" || finite(v))
    return;
  if (typeof v === "string") {
    state.strings += v.length;
    if (state.strings > RETAINED_UI_BUDGETS.stringCodeUnits)
      add(out, "budget-exceeded", path, "String budget exceeded.");
    return;
  }
  if (dense(v)) {
    if (state.values + v.length > RETAINED_UI_BUDGETS.jsonValues) {
      add(out, "budget-exceeded", path, "Array budget exceeded.");
      return;
    }
    v.forEach((item, i) => json(item, `${path}[${i}]`, out, state, depth + 1));
    return;
  }
  if (object(v) && Reflect.ownKeys(v).every((key) => { const d = typeof key === "string" ? Object.getOwnPropertyDescriptor(v, key) : undefined; return d?.enumerable === true && "value" in d; })) {
    const entries = Object.entries(v);
    if (state.values + entries.length > RETAINED_UI_BUDGETS.jsonValues) {
      add(out, "budget-exceeded", path, "Object budget exceeded.");
      return;
    }
    entries.forEach(([key, item]) => json(item, `${path}.${key}`, out, state, depth + 1));
    return;
  }
  add(out, "invalid-json", path, "Expected plain dense finite JSON without functions, symbols or accessors.");
}
function style(v: unknown, path: string, out: RetainedUiDiagnostic[]): void {
  if (!object(v)) {
    add(out, "invalid-value", path, "Expected style object.");
    return;
  }
  keys(v, ["layout", "x", "y", "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "padding", "gap", "grow", "align", "clip", "visible", "opacity", "pointerEvents", "zIndex", "background", "foreground", "borderColor", "borderWidth", "cornerRadius", "fontId", "fontSize"], path, out);
  if (!["absolute", "stack", "flex-row", "flex-column"].includes(v.layout as string))
    add(out, "invalid-value", `${path}.layout`, "Unsupported layout mode.");
  bounded(v.x, `${path}.x`, out);
  bounded(v.y, `${path}.y`, out);
  bounded(v.width, `${path}.width`, out, 0);
  bounded(v.height, `${path}.height`, out, 0);
  bounded(v.padding, `${path}.padding`, out, 0);
  bounded(v.gap, `${path}.gap`, out, 0);
  bounded(v.grow, `${path}.grow`, out, 0);
  for (const key of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const)
    if (v[key] !== undefined)
      bounded(v[key], `${path}.${key}`, out, 0);
  if (finite(v.minWidth) && finite(v.maxWidth) && v.minWidth > v.maxWidth || finite(v.minHeight) && finite(v.maxHeight) && v.minHeight > v.maxHeight)
    add(out, "invalid-value", path, "Minimum size cannot exceed maximum size.");
  if (!["start", "center", "end", "stretch"].includes(v.align as string) || !["auto", "none"].includes(v.pointerEvents as string))
    add(out, "invalid-value", path, "Invalid alignment or pointer mode.");
  if (typeof v.clip !== "boolean" || typeof v.visible !== "boolean" || !bounded(v.opacity, `${path}.opacity`, out, 0, 1) || !Number.isSafeInteger(v.zIndex) || (v.zIndex as number) < -2147483648 || (v.zIndex as number) > 2147483647)
    add(out, "invalid-value", path, "Invalid clip, visibility, opacity or z-index.");
  if (v.background !== null) color(v.background, `${path}.background`, out);
  color(v.foreground, `${path}.foreground`, out);
  if (v.borderColor !== null) color(v.borderColor, `${path}.borderColor`, out);
  bounded(v.borderWidth, `${path}.borderWidth`, out, 0);
  bounded(v.cornerRadius, `${path}.cornerRadius`, out, 0);
  if (v.fontId !== null) validId(v.fontId, `${path}.fontId`, out);
  bounded(v.fontSize, `${path}.fontSize`, out, 1);
}
function content(v: unknown, path: string, out: RetainedUiDiagnostic[]): RetainedUiNodeKind | undefined {
  if (!object(v) || !["container", "text", "image", "viewport", "chart"].includes(v.kind as string)) {
    add(out, "invalid-value", path, "Expected supported content kind.");
    return;
  }
  const field = v.kind === "text" ? "text" : v.kind === "image" ? "assetId" : v.kind === "viewport" ? "surfaceId" : v.kind === "chart" ? "chartSpecId" : undefined;
  keys(v, field ? ["kind", field] : ["kind"], path, out);
  if (field && (typeof v[field] !== "string" || field !== "text" && !(v[field] as string).length))
    add(out, "invalid-value", `${path}.${field}`, "Text must be a string and external references must be non-empty.");
  return v.kind as RetainedUiNodeKind;
}
function a11y(v: unknown, path: string, out: RetainedUiDiagnostic[]): void { if (!object(v)) {
  add(out, "invalid-value", path, "Expected accessibility object.");
  return;
} keys(v, ["role", "label", "value"], path, out); if (!["none", "text", "img", "button", "region", "application"].includes(v.role as string))
  add(out, "invalid-value", `${path}.role`, "Unsupported accessibility role."); for (const key of ["label", "value"] as const)
  if (v[key] !== undefined && typeof v[key] !== "string")
    add(out, "invalid-value", `${path}.${key}`, "Expected text."); }
export function validateRetainedUiTree(input: unknown): RetainedUiValidation {
  const diagnostics: RetainedUiDiagnostic[] = [];
  try {
    json(input, "$", diagnostics, { values: 0, strings: 0 });
  }
  catch {
    add(diagnostics, "invalid-json", "$", "Input could not be inspected as plain JSON.");
  }
  if (diagnostics.some((d) => d.code === "invalid-json" || d.code === "budget-exceeded") || !object(input))
    return { valid: false, diagnostics };
  keys(input, ["schemaVersion", "id", "revision", "width", "height", "rootId", "nodes"], "$", diagnostics);
  if (input.schemaVersion !== RETAINED_UI_SCHEMA_VERSION)
    add(diagnostics, "invalid-schema", "$.schemaVersion", "Expected retained UI schema version 1.");
  validId(input.id, "$.id", diagnostics);
  validId(input.rootId, "$.rootId", diagnostics);
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0)
    add(diagnostics, "invalid-value", "$.revision", "Revision must be a non-negative safe integer.");
  bounded(input.width, "$.width", diagnostics, 0);
  bounded(input.height, "$.height", diagnostics, 0);
  if (!dense(input.nodes)) {
    add(diagnostics, "invalid-value", "$.nodes", "Expected dense node array.");
    return { valid: false, diagnostics };
  }
  if (input.nodes.length > RETAINED_UI_BUDGETS.nodes) {
    add(diagnostics, "budget-exceeded", "$.nodes", "Node budget exceeded.");
    return { valid: false, diagnostics };
  }
  const nodes = new Map<string, RetainedUiNode>();
  let childCount = 0;
  input.nodes.forEach((raw, i) => { const p = `$.nodes[${i}]`; if (!object(raw)) {
    add(diagnostics, "invalid-value", p, "Expected node object.");
    return;
  } keys(raw, ["id", "revision", "parentId", "children", "style", "content", "a11y"], p, diagnostics); const goodId = validId(raw.id, `${p}.id`, diagnostics); if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0)
    add(diagnostics, "invalid-value", `${p}.revision`, "Revision must be a non-negative safe integer."); if (raw.parentId !== null)
    validId(raw.parentId, `${p}.parentId`, diagnostics); if (!dense(raw.children) || raw.children.some((x) => typeof x !== "string"))
    add(diagnostics, "invalid-value", `${p}.children`, "Expected dense child-id array.");
  else {
    childCount += raw.children.length;
    if (new Set(raw.children).size !== raw.children.length)
      add(diagnostics, "duplicate-id", `${p}.children`, "Child ids must be unique per parent.");
  } style(raw.style, `${p}.style`, diagnostics); const kind = content(raw.content, `${p}.content`, diagnostics); a11y(raw.a11y, `${p}.a11y`, diagnostics); if (kind && kind !== "container" && dense(raw.children) && raw.children.length)
    add(diagnostics, "invalid-value", `${p}.children`, "Only container nodes may have children."); if (goodId) {
    if (nodes.has(raw.id as string))
      add(diagnostics, "duplicate-id", `${p}.id`, "Node id must be globally unique.");
    else
      nodes.set(raw.id as string, raw as unknown as RetainedUiNode);
  } });
  if (childCount > RETAINED_UI_BUDGETS.children)
    add(diagnostics, "budget-exceeded", "$.nodes", "Child-reference budget exceeded.");
  const root = nodes.get(input.rootId as string);
  if (!root)
    add(diagnostics, "missing-reference", "$.rootId", "Root node is missing.");
  else if (root.parentId !== null)
    add(diagnostics, "parent-child-mismatch", "$.rootId", "Root parent must be null.");
  else if (root.style.x !== 0 || root.style.y !== 0 || root.style.width !== input.width || root.style.height !== input.height)
    add(diagnostics, "invalid-value", "$.rootId", "Root style must start at zero and match the tree extent.");
  for (const node of nodes.values()) {
    if (node.id !== input.rootId && node.parentId === null)
      add(diagnostics, "parent-child-mismatch", `$.nodes.${node.id}.parentId`, "Only root may have null parent.");
    if (node.parentId !== null && !nodes.get(node.parentId)?.children.includes(node.id))
      add(diagnostics, "parent-child-mismatch", `$.nodes.${node.id}.parentId`, "Parent must contain this child id.");
    node.children.forEach((childId) => { const child = nodes.get(childId); if (!child)
      add(diagnostics, "missing-reference", `$.nodes.${node.id}.children`, `Missing child ${childId}.`);
    else if (child.parentId !== node.id)
      add(diagnostics, "parent-child-mismatch", `$.nodes.${node.id}.children`, `Child ${childId} points to another parent.`); });
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const walk = (nodeId: string, depth: number): void => { if (visiting.has(nodeId)) {
    add(diagnostics, "cycle", `$.nodes.${nodeId}`, "Node graph contains a cycle.");
    return;
  } if (visited.has(nodeId))
    return; if (depth > RETAINED_UI_BUDGETS.treeDepth) {
    add(diagnostics, "budget-exceeded", `$.nodes.${nodeId}`, "Tree depth budget exceeded.");
    return;
  } const node = nodes.get(nodeId); if (!node)
    return; visiting.add(nodeId); node.children.forEach((child) => walk(child, depth + 1)); visiting.delete(nodeId); visited.add(nodeId); };
  if (root)
    walk(root.id, 0);
  const reachable = new Set(visited);
  for (const id of nodes.keys())
    if (!visited.has(id))
      walk(id, 0);
  for (const id of nodes.keys())
    if (!reachable.has(id))
      add(diagnostics, "unreachable", `$.nodes.${id}`, "Node is unreachable from root.");
  return { valid: diagnostics.length === 0, diagnostics, ...(diagnostics.length ? {} : { tree: input as unknown as RetainedUiTree }) };
}
