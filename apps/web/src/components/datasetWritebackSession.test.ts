import { describe, expect, it, vi } from "vitest";
import { ServerRequestError } from "@bim-studio/server-sdk";
import { DatasetWritebackSession } from "./datasetWritebackSession";
import type { DataWritebackConfig, DataWritebackSnapshot } from "@bim-studio/contracts";

const config: DataWritebackConfig = { version: 1, recordPath: "/records/{id}", fields: [{ key: "amount", type: "number", required: true, min: 0 }, { key: "note", type: "string" }] };
const initial: DataWritebackSnapshot = { version: '"v1"', values: { amount: 2, note: "original" } };
function setup() {
  const read = vi.fn().mockResolvedValue(initial), write = vi.fn().mockResolvedValue({ version: '"v2"', values: { amount: 3, note: "original" } });
  return { read, write, session: new DatasetWritebackSession(config, { read, write }) };
}
describe("business writeback session", () => {
  it("requires validation and explicit confirmation, and excludes duplicate submits", async () => {
    const { session, write } = setup(); await session.read("order-1");
    session.edit("amount", "-1"); session.review(); await session.submit(); expect(write).not.toHaveBeenCalled();
    expect(session.getSnapshot().issues).toHaveLength(1);
    session.edit("amount", "3"); await session.submit(); expect(write).not.toHaveBeenCalled();
    session.review(); await Promise.all([session.submit(), session.submit()]);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![1]).toEqual({ expectedVersion: '"v1"', values: { amount: 3, note: "original" } });
    expect(session.getSnapshot().saved).toBe(true);
  });
  it("keeps draft on conflict and rebases only edited fields after an explicit decision", async () => {
    const { session, read, write } = setup(); await session.read("order-1"); session.edit("amount", "3"); session.review();
    write.mockRejectedValueOnce(new ServerRequestError("记录已变化", 409, { outcome: "not-written" })); await session.submit();
    session.review(); await session.submit(); expect(write).toHaveBeenCalledOnce();
    read.mockResolvedValueOnce({ version: '"v2"', values: { amount: 4, note: "remote edit" } });
    await session.read("order-1", true); expect(session.getSnapshot().draft.amount).toBe("3");
    session.resolveRemote(true); expect(session.getSnapshot().draft).toEqual({ amount: "3", note: "remote edit" });
    session.review(); await session.submit(); expect(write.mock.calls[1]![1].expectedVersion).toBe('"v2"');
  });
  it("never replays an uncertain write and keeps its draft when reread fails", async () => {
    const { session, read, write } = setup(); await session.read("order-1"); session.edit("amount", "3"); session.review();
    write.mockRejectedValueOnce(new Error("connection lost")); await session.submit();
    read.mockRejectedValueOnce(new Error("offline")); await session.read("order-1", true);
    session.review(); await session.submit();
    expect(write).toHaveBeenCalledOnce(); expect(session.getSnapshot().needsReconcile).toBe(true);
    expect(session.getSnapshot().draft.amount).toBe("3");
  });
  it("ignores late results after the form is disposed", async () => {
    const { session, read } = setup(); let finish!: (value: DataWritebackSnapshot) => void;
    read.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const pending = session.read("order-1"); const before = session.getSnapshot(); session.dispose(); finish(initial); await pending;
    expect(session.getSnapshot()).toBe(before); expect(read.mock.calls[0]![1].aborted).toBe(true);
  });
  it.each([401, 403, 404])("preserves an explicit authorization/resource failure (%s)", async status => {
    const { session, write } = setup(); await session.read("order-1"); session.edit("amount", "3"); session.review();
    write.mockRejectedValueOnce(new ServerRequestError("没有访问权限或资源不存在", status, { message: "没有访问权限或资源不存在" }));
    await session.submit();
    expect(session.getSnapshot().error).toBe("没有访问权限或资源不存在");
    expect(session.getSnapshot().draft.amount).toBe("3"); expect(write).toHaveBeenCalledOnce();
  });
});
