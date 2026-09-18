import { describe, expect, it } from "vitest";
import { isPublicAssetKey } from "./publicAssetKey.js";

describe("public asset key", () => {
  it.each([
    "projects/p/models/model/geometry.glb",
    "projects/p/models/设备一号/层级.json",
    "projects/p/images/drawing.v2.png",
    "projects/p/images/a~draft.png",
    "branding/logo.svg",
  ])("allows a canonical existing public resource: %s", key => {
    expect(isPublicAssetKey(key)).toBe(true);
  });

  it.each([
    "projects/p/publication-resources",
    "projects/p/publication-resources/sha256/abc",
    "PROJECTS/P/PUBLICATION-RESOURCES/SHA256/ABC",
    "projects/p/Publication-Resources/sha256/abc",
    "projects/p/./publication-resources/sha256/abc",
    "./projects/p/publication-resources/sha256/abc",
    "projects//p/publication-resources/sha256/abc",
    "projects/p//publication-resources/sha256/abc",
    "/projects/p/publication-resources/sha256/abc",
    "projects/p/publication-resources/sha256/abc/",
    "projects/p/models/../publication-resources/sha256/abc",
    "projects\\p\\publication-resources\\sha256\\abc",
    "projects/p/publication-resources./sha256/abc",
    "projects/p/publication-resources /sha256/abc",
    "projects/p/PUBLIC~1/sha256/abc",
    "projects/p/public~12/sha256/abc",
    "projects/p/PUBLIC~1.DIR/sha256/abc",
    "projects/P~1/publication-resources/sha256/abc",
    "projects/p/%2epublication-resources/sha256/abc",
    "projects/p/%252e/publication-resources/sha256/abc",
    "projects%2fp%2fpublication-resources/sha256/abc",
  ])("rejects private bytes and filesystem or encoded aliases: %s", key => {
    expect(isPublicAssetKey(key)).toBe(false);
  });

  it.each([
    "", ".", "..", "a//b", "a/./b", "a/../b", "a\\b", "a/b.", "a/b ",
    "a/b:stream", "a/b?query", "a/b*", "a/b|", "a/<b>", "a/\"b", "a/b\u0000", "a/b\u001f", "a/b\u007f",
    "a/con", "a/CON.txt", "a/prn", "a/AUX.png", "a/nul", "a/COM1", "a/com9.glb", "a/LPT1", "a/lpt9.json",
  ])("rejects unsafe public keys too: %s", key => {
    expect(isPublicAssetKey(key)).toBe(false);
  });
});
