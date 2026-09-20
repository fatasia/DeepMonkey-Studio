import { describe, expect, it } from "vitest";
import { parseEditorDiagnosticsSnapshotMirror } from "./editorDiagnosticsSnapshotMirror.js";

function validMirror() {
  return {
    sceneId: "scene-1", revision: 3, capturedAtMs: 1_789,
    resources: [{ resourceId: "present-color", frameId: "frame-9", width: 1920, height: 1080,
      format: "rgba16float", byteLength: 33_177_600 }],
  };
}

describe("editor diagnostics snapshot mirror", () => {
  it("accepts a well-formed single-resource summary", () => {
    expect(parseEditorDiagnosticsSnapshotMirror(validMirror())).toMatchObject({ sceneId: "scene-1", revision: 3 });
  });

  it("rejects the whole mirror when any resource is malformed or duplicated", () => {
    const duplicated = validMirror();
    (duplicated.resources as unknown[]).push({ ...duplicated.resources[0] });
    expect(parseEditorDiagnosticsSnapshotMirror(duplicated)).toBeUndefined();
    const zeroSized = validMirror();
    (zeroSized.resources[0] as { width: number }).width = 0;
    expect(parseEditorDiagnosticsSnapshotMirror(zeroSized)).toBeUndefined();
    const unknownResource = validMirror();
    (unknownResource.resources[0] as { resourceId: string }).resourceId = "made-up-resource";
    expect(parseEditorDiagnosticsSnapshotMirror(unknownResource)).toBeUndefined();
  });

  it("rejects missing fields and out-of-range timestamps", () => {
    expect(parseEditorDiagnosticsSnapshotMirror({ ...validMirror(), sceneId: "" })).toBeUndefined();
    expect(parseEditorDiagnosticsSnapshotMirror({ ...validMirror(), capturedAtMs: -1 })).toBeUndefined();
    expect(parseEditorDiagnosticsSnapshotMirror({ ...validMirror(), resources: [] })).toBeUndefined();
  });
});
