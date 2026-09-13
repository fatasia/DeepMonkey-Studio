import { describe, expect, it } from "vitest";
import { ViewerSnapshotReadiness } from "./viewerSnapshotReadiness";

describe("ViewerSnapshotReadiness", () => {
  it("allows an empty new draft but rejects an existing scene in a newly created engine", () => {
    const ready = new ViewerSnapshotReadiness();
    expect(ready.ready(undefined, false, false)).toBe(true);
    expect(ready.ready("existing", false, false)).toBe(false);
    ready.bindSaved("first-save"); expect(ready.ready("first-save", false, false)).toBe(true);
    expect(ready.ready("first-save", true, false)).toBe(false);
  });
  it("blocks partial restore, keeps failures blocked and ignores an old completion after rebinding", () => {
    const ready = new ViewerSnapshotReadiness(); const old = ready.begin("old");
    expect(ready.ready("old", false, false)).toBe(false);
    const next = ready.begin("next"); ready.complete(old);
    expect(ready.ready("next", false, false)).toBe(false);
    ready.complete(next); expect(ready.ready("next", false, false)).toBe(true);
    expect(ready.ready("old", false, false)).toBe(false);
  });
  it("allows explicit clearing and retry without treating zero models as corruption", () => {
    const ready = new ViewerSnapshotReadiness(); const first = ready.begin("scene"); ready.complete(first);
    expect(ready.ready("scene", false, true)).toBe(false);
    ready.cancelRestore(); expect(ready.ready("scene", false, false)).toBe(true);
    const retry = ready.begin("scene"); ready.complete(retry);
    expect(ready.ready("scene", false, false)).toBe(true);
  });
});
