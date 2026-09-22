import { describe, expect, it } from "vitest";
import { acceptedPostgresRevision, parsePostgresState, postgresStateWrite } from "./postgresStateRevision.js";
import { defaultDocument } from "./storeUtils.js";

describe("PostgreSQL metadata revision protocol", () => {
  it("preserves BIGINT revisions beyond JS safe integers", () => {
    const revision = "9007199254740993";
    const encoded = Buffer.from(JSON.stringify({ revision, document: defaultDocument() })).toString("base64");
    expect(parsePostgresState(encoded)?.revision).toBe(revision);
    expect(acceptedPostgresRevision("9007199254740994\n", revision)).toBe("9007199254740994");
    expect(postgresStateWrite(defaultDocument(), revision)).toContain(`AND revision = ${revision}`);
  });
  it.each(["-1", "1 OR 1=1", "01", "1.1", "9223372036854775808"])("rejects invalid revision %s", revision => {
    expect(() => postgresStateWrite(defaultDocument(), revision)).toThrow("版本无效");
  });
  it("cannot promote empty or mismatched acknowledgements to a successful write", () => {
    expect(acceptedPostgresRevision("", "5")).toBeUndefined();
    expect(() => acceptedPostgresRevision("7", "5")).toThrow("版本不一致");
    expect(acceptedPostgresRevision("0", undefined)).toBe("0");
    expect(parsePostgresState("")).toBeUndefined();
    expect(postgresStateWrite(defaultDocument(), undefined)).toContain("ON CONFLICT (id) DO NOTHING");
  });
});
