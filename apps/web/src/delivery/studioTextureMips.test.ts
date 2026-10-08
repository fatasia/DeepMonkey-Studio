import { expect, it } from "vitest";
import { studioTextureMips } from "./studioTextureMips";

it("keeps transform-only texture identity and pixels stable while requesting GPU mip filtering", () => {
  const texture = { id: "x", revision: 0, semantic: "baseColor" as const, width: 2, height: 2, data: new Uint8Array(16) };
  const generated = studioTextureMips(texture);
  expect(generated.generateMipmaps).toBe(true); expect(generated.data).toBe(texture.data);
  expect(studioTextureMips(texture)).toBe(generated);
  for (const source of [{ ...texture, generateMipmaps: false }, { ...texture, sampler: { minFilter: "nearest" as const } },
    { ...texture, mipmaps: [{ width: 1, height: 1, data: new Uint8Array(4) }] }]) {
    expect(studioTextureMips(source)).toBe(source);
  }
});
