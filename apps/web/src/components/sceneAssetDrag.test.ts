import { describe, expect, it } from "vitest";
import { readSceneAssetDrag } from "./sceneAssetDrag";

describe("scene asset drag identifiers", () => {
  it.each(["library", "model"])("accepts a %s identifier", source => {
    expect(readSceneAssetDrag(JSON.stringify({ source, id: "asset-1" }))).toEqual({ source, id: "asset-1" });
  });
  it.each(["", "null", "[]", "{", '{"source":"file","id":"x"}', '{"source":"model","id":""}', '{"source":"model","id":7}', '{"source":"model","id":"x","url":"external"}', "x".repeat(2049)])("rejects malformed or foreign payload %s", raw => {
    expect(readSceneAssetDrag(raw)).toBeUndefined();
  });
});
