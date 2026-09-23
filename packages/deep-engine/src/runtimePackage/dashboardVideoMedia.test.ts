import { describe, expect, it } from "vitest";
import { hasDashboardVideoAudioTrack } from "./dashboardVideoMedia.js";

function box(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength, false);
  bytes.set([...type].map(character => character.charCodeAt(0)), 4);
  bytes.set(payload, 8);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

describe("dashboard MP4 audio-track probe", () => {
  it("finds an audio handler without attempting codec decode", () => {
    const handler = new Uint8Array(12);
    handler.set([0x73, 0x6f, 0x75, 0x6e], 8); // hdlr.handler_type = soun
    const audio = concat(box("ftyp", new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])),
      box("moov", box("trak", box("mdia", box("hdlr", handler)))));
    expect(hasDashboardVideoAudioTrack(audio)).toBe(true);
  });

  it("keeps a video-only container silent", () => {
    const videoHandler = new Uint8Array(12);
    videoHandler.set([0x76, 0x69, 0x64, 0x65], 8); // hdlr.handler_type = vide
    const video = box("moov", box("trak", box("mdia", box("hdlr", videoHandler))));
    expect(hasDashboardVideoAudioTrack(video)).toBe(false);
  });
});
