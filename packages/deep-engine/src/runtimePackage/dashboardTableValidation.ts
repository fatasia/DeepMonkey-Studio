import { array, fields, record, requireValue, string } from "./primitives.js";
import { decodedLength } from "./deep2d.js";
import type { DashboardRuntimePageV1 } from "./dashboardCompositionTypes.js";

/** Structural validation and resource ownership; table ordering itself is frozen by the Web producer. */
export function validateDashboardTables(value: unknown, pages: readonly DashboardRuntimePageV1[], families: number, path: string): string[] {
  const slots = new Set<string>(), tableIds = new Set<string>(), resources = new Map<string, string>();
  const base = new Map(pages.flatMap(page => page.nodes.filter(node => node.deep2d).map(node => [node.deep2d!, node.id] as const)));
  let views = 0, exportBytes = 0;
  const added = new Set<string>();
  for (const [i, raw] of array(value, path, 32).entries()) {
    const p = `${path}[${i}]`, table = record(raw, p);
    fields(table, ["id", "pageId", "nodeIds", "title", "families"], [], p);
    const id = string(table.id, p), page = pages.find(page => page.id === table.pageId);
    requireValue(id.length > 0 && id.length <= 256 && !tableIds.has(id) && page, p, "Invalid table identity/page"); tableIds.add(id);
    const title = string(table.title, p); requireValue(title.length <= 256 && !/[\u0000-\u001f]/.test(title), p, "Invalid table title");
    const owned = new Set<string>();
    let slotFrame: readonly number[] | undefined;
    for (const rawId of array(table.nodeIds, p, 128)) {
      const slot = string(rawId, p), node = page.nodes.find(node => node.id === slot);
      requireValue(node && node.deep2d && !node.chart && !node.hitId && !slots.has(slot), p, "Invalid or multiply-owned table slot");
      requireValue(!slotFrame || slotFrame.every((value, index) => value === node.frame[index]), p, "Table slots must share their widget frame");
      slotFrame = node.frame;
      slots.add(slot); owned.add(slot);
    }
    requireValue(owned.size > 0, p, "Table requires content slots");
    const familyValues = array(table.families, p, 16);
    requireValue(familyValues.length === families, p, "Table filter family count differs");
    for (const rawFamily of familyValues) {
      const family = record(rawFamily, p); fields(family, ["orders"], [], p);
      const orders = array(family.orders, p, 257), orderKeys = new Set<string>();
      requireValue(orders.length > 0, p, "Table requires its authored order");
      for (const [orderIndex, rawOrder] of orders.entries()) {
        const order = record(rawOrder, p); fields(order, ["column", "direction", "exports", "pages"], [], p);
        requireValue(orderIndex === 0 ? order.column === null && order.direction === null
          : typeof order.column === "string" && order.column.length > 0 && order.column.length <= 256 && ["asc", "desc"].includes(String(order.direction)), p, "Invalid table order");
        const key = JSON.stringify([order.column, order.direction]); requireValue(!orderKeys.has(key), p, "Duplicate table order"); orderKeys.add(key);
        const exports = record(order.exports, p); fields(exports, ["csv", "xlsx"], [], p);
        for (const format of ["csv", "xlsx"]) exportBytes += decodedLength(exports[format], p);
        requireValue(exportBytes <= 64 * 1024 * 1024, p, "Table export byte budget exceeded");
        const viewValues = array(order.pages, p, 512); requireValue(viewValues.length > 0, p, "Table requires a page");
        for (const rawView of viewValues) {
          requireValue(++views <= 512, p, "Table view budget exceeded");
          const view = record(rawView, p); fields(view, ["layers", "controls"], [], p);
          requireValue(Array.isArray(view.layers) && view.layers.length > 0, p, "Table requires visible content");
          const used = new Set<string>();
          for (const rawLayer of array(view.layers, p, 128)) {
            const layer = record(rawLayer, p); fields(layer, ["nodeId", "deep2d", "clip"], ["origin"], p);
            const slot = string(layer.nodeId, p), resource = string(layer.deep2d, p);
            requireValue(owned.has(slot) && !used.has(slot), p, "Invalid table layer slot"); used.add(slot);
            requireValue(!base.has(resource) || owned.has(base.get(resource)!), p, "Table cannot borrow another node's resource");
            requireValue(!resources.has(resource) || resources.get(resource) === id, p, "Table resource has multiple owners");
            resources.set(resource, id); if (!base.has(resource)) added.add(resource);
            if (layer.clip !== null) rect(layer.clip, p);
            if (layer.origin !== undefined) {
              const origin = array(layer.origin, p, 2);
              requireValue(origin.length === 2 && origin.every(value => typeof value === "number" && Number.isFinite(value)
                && Math.abs(value) <= 16_777_216), p, "Invalid table layer origin");
            }
          }
          for (const rawControl of array(view.controls, p, 260)) {
            const control = record(rawControl, p); fields(control, ["action", "column", "rect", "enabled"], [], p);
            requireValue(["csv", "xlsx", "sort", "previous", "next"].includes(String(control.action)) && typeof control.enabled === "boolean", p, "Invalid table control");
            requireValue(control.action === "sort" ? typeof control.column === "string" && orders.some(raw => (raw as { column?: unknown }).column === control.column) : control.column === null, p, "Invalid table control column");
            rect(control.rect, p);
          }
        }
      }
    }
  }
  return [...added];
}
function rect(value: unknown, path: string) {
  const values = array(value, path, 4);
  requireValue(values.length === 4 && values.every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 16_777_216)
    && (values[2] as number) > 0 && (values[3] as number) > 0, path, "Invalid table rectangle");
}
