import { expect, it } from "vitest";
import { validateDashboardTablePaint } from "./dashboardTablePaintCapture";

// Explicit DOM/style relations, not a browser screenshot or layout acceptance test.
function fixture() {
  const styles = new Map<object, Record<string, string>>();
  const table = { querySelectorAll: () => [behind, sticky, header] };
  const root = { querySelector: () => table, querySelectorAll: () => [table], contains: () => true,
    ownerDocument: { defaultView: { getComputedStyle: (element: object) => ({
      position: "static", zIndex: "auto", transform: "none", visibility: "visible", display: "block", ...styles.get(element) }) } } };
  const cell = (index: number) => ({ parentElement: root, closest: (selector: string) => selector === "table" ? table : cells[index],
    compareDocumentPosition: (other: object) => cells.indexOf(other as never) > index ? 4 : 2,
    getBoundingClientRect: () => ({ width: 30, height: 20 }) });
  const behind = cell(0), sticky = cell(1), header = cell(2), cells = [behind, sticky, header];
  styles.set(sticky, { position: "sticky", zIndex: "2" }); styles.set(header, { position: "sticky", zIndex: "4" });
  const text = cells.map((element, index) => ({ element, role: { kind: "cell", row: 0, column: String(index) } }));
  const backgrounds = cells;
  const valid = [0, 1, 2].flatMap(index => [{ kind: "background", index }, { kind: "text", index }]);
  const validate = (paint = valid, bg = backgrounds) => validateDashboardTablePaint(root as never, text as never, bg as never, paint as never);
  return { validate, styles, sticky, header, valid, backgrounds };
}
it("accepts actual 0/2/4 cell stacking supplied in back-to-front order", () => {
  expect(() => fixture().validate()).not.toThrow();
});
it("rejects reversed stacking, incomplete references and missing sticky-cell backgrounds", () => {
  const value = fixture();
  expect(() => value.validate([...value.valid.slice(2, 4), ...value.valid.slice(0, 2), ...value.valid.slice(4)])).toThrow("stacking");
  expect(() => value.validate(value.valid.slice(1))).toThrow("Incomplete");
  expect(() => value.validate(value.valid.filter(entry => !(entry.kind === "background" && entry.index === 2)),
    value.backgrounds.slice(0, 2))).toThrow("missing");
});
it("does not infer ordering across unsupported nested contexts", () => {
  const value = fixture(); value.styles.set(value.sticky, { position: "sticky", zIndex: "8" });
  expect(() => value.validate()).toThrow("stacking");
  value.styles.set(value.sticky, { position: "sticky", zIndex: "2", transform: "matrix(1,0,0,1,0,0)" });
  expect(() => value.validate()).toThrow("contexts");
});
it("requires actual DOM order for cells at the same measured stacking level", () => {
  const value = fixture(); value.styles.set(value.header, { position: "sticky", zIndex: "2" });
  expect(() => value.validate([...value.valid.slice(0, 2), ...value.valid.slice(4), ...value.valid.slice(2, 4)]))
    .toThrow("DOM order");
});
