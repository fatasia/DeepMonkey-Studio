import { expect, it } from "vitest";
import { dashboardFrozenFontStyle } from "./dashboardFrozenFontStyle";

function font(weight = 700, selection = 0) {
  const bytes = new Uint8Array(92), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000); view.setUint16(4, 1);
  view.setUint32(12, 0x4f532f32); view.setUint32(20, 28); view.setUint32(24, 64);
  view.setUint16(32, weight); view.setUint16(90, selection);
  return bytes;
}
it("reads actual static normal and italic weights", () => {
  expect(dashboardFrozenFontStyle(font())).toEqual({ weight: 700, style: "normal" });
  expect(dashboardFrozenFontStyle(font(400, 1))).toEqual({ weight: 400, style: "italic" });
});
it("rejects truncated, collection, variable and unsupported faces", () => {
  for (const bytes of [new Uint8Array(), font().subarray(0, 91), font(0), font(400, 512)])
    expect(() => dashboardFrozenFontStyle(bytes)).toThrow();
  const collection = font(); new DataView(collection.buffer).setUint32(0, 0x74746366);
  expect(() => dashboardFrozenFontStyle(collection)).toThrow("individual");
  const variable = font(); new DataView(variable.buffer).setUint32(12, 0x66766172);
  expect(() => dashboardFrozenFontStyle(variable)).toThrow("Variable");
});
