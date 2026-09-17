import { afterEach, expect, it, vi } from "vitest";
import { open } from "node:fs/promises";
import path from "node:path";
import { readDashboardWindowsExecutable } from "./dashboardWindowsExecutable.js";

vi.mock("node:fs/promises", () => ({ open: vi.fn() }));
afterEach(() => vi.resetAllMocks());
function fixture() {
  const bytes = Buffer.alloc(128); bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64);
  const stat = vi.fn(async () => ({ isFile: () => true, size: bytes.length, mtimeMs: 1 }));
  const read = vi.fn(async (target: Buffer, offset: number, length: number, position: number) => {
    const count = Math.min(length, 17, Math.max(0, bytes.length - position));
    bytes.copy(target, offset, position, position + count); return { bytesRead: count };
  });
  const close = vi.fn(async () => {});
  vi.mocked(open).mockResolvedValue({ stat, read, close } as never);
  return { bytes, stat, read, close, run: (signal?: AbortSignal) => readDashboardWindowsExecutable(path.resolve("player.exe"), signal) };
}
it("handles partial reads and closes the single source handle", async () => {
  const f = fixture(); expect(await f.run()).toEqual(f.bytes);
  expect(open).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledTimes(1);
});
it("rejects oversize before allocating or reading", async () => {
  const f = fixture(); f.stat.mockResolvedValue({ isFile: () => true, size: 512 * 1024 ** 2 + 1, mtimeMs: 1 });
  await expect(f.run()).rejects.toThrow("512 MiB"); expect(f.read).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
});
it("rejects truncation, growth and same-size modification", async () => {
  for (const kind of ["truncate", "grow", "modify"]) {
    const f = fixture();
    if (kind === "truncate") f.read.mockResolvedValue({ bytesRead: 0 });
    if (kind === "grow") {
      const read = f.read.getMockImplementation()!;
      f.read.mockImplementation(async (...args) => args[3] === f.bytes.length ? { bytesRead: 1 } : read(...args));
    }
    if (kind === "modify") f.stat.mockResolvedValueOnce({ isFile: () => true, size: 128, mtimeMs: 1 })
      .mockResolvedValue({ isFile: () => true, size: 128, mtimeMs: 2 });
    await expect(f.run()).rejects.toThrow("changed during read"); expect(f.close).toHaveBeenCalledOnce();
  }
});
it("cancels between chunks and closes the handle", async () => {
  const f = fixture(), controller = new AbortController(), read = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (...args) => { controller.abort(); return read(...args); });
  await expect(f.run(controller.signal)).rejects.toThrow();
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledOnce();
});
