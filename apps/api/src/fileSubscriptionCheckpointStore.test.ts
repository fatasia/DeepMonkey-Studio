import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSubscriptionCheckpointStore } from "./fileSubscriptionCheckpointStore.js";
import { PersistentSubscriptionSession, type SourceLifecycleEvent, type SourceSample, type SubscriptionCheckpoint, type SubscriptionSource } from "./subscriptionRuntime.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "subscription-checkpoint-"));
  directories.push(dataDir);
  return { dataDir, store: new FileSubscriptionCheckpointStore(dataDir) };
}

const checkpoint = (lastSequence: number): SubscriptionCheckpoint => ({
  connectionId: "project:line/1",
  generation: 2,
  lastSequence,
  lastTimestamp: "2026-09-28T01:00:00.000Z",
  updatedAt: "2026-09-28T01:00:01.000Z",
});

describe("FileSubscriptionCheckpointStore", () => {
  it("restores an actual T24 session across new store instances and reports a sequence gap", async () => {
    const { dataDir } = await fixture();
    const sources: Array<{ sample: (sample: SourceSample) => void; lifecycle: (event: SourceLifecycleEvent) => void }> = [];
    const events: number[] = [];
    const gaps: number[] = [];
    function createSession(store: FileSubscriptionCheckpointStore) {
      return new PersistentSubscriptionSession({
        connectionId: "project:line/1", projectId: "project", protocol: "mqtt", checkpointStore: store,
        sourceFactory: async () => {
          let onSample: (sample: SourceSample) => void = () => undefined;
          let onLifecycle: (event: SourceLifecycleEvent) => void = () => undefined;
          sources.push({ sample: (sample) => onSample(sample), lifecycle: (event) => onLifecycle(event) });
          return {
            protocol: "mqtt", start: async () => undefined, dispose: async () => undefined,
            onSample: (handler) => { onSample = handler; return () => { onSample = () => undefined; }; },
            onLifecycle: (handler) => { onLifecycle = handler; return () => { onLifecycle = () => undefined; }; },
            stats: () => ({}),
          } satisfies SubscriptionSource;
        },
        project: (sample) => ({ id: `event-${sample.sequence}`, projectId: "project", source: "mqtt", key: sample.topic, value: sample.value, timestamp: sample.timestamp, sequence: sample.sequence }),
        onEvent: (event) => events.push(event.sequence!),
        onGapReport: (gap) => gaps.push(gap.estimatedCount!),
      });
    }
    const first = createSession(new FileSubscriptionCheckpointStore(dataDir));
    await first.start(); sources[0]!.lifecycle({ kind: "ready" });
    sources[0]!.sample({ topic: "line", value: 1, timestamp: "2026-09-28T00:00:01Z", sequence: 1 });
    await first.stop();
    const resumed = createSession(new FileSubscriptionCheckpointStore(dataDir));
    await resumed.start(); sources[1]!.lifecycle({ kind: "ready" });
    sources[1]!.sample({ topic: "line", value: 1, timestamp: "2026-09-28T00:00:01Z", sequence: 1 });
    sources[1]!.sample({ topic: "line", value: 4, timestamp: "2026-09-28T00:00:04Z", sequence: 4 });
    expect(events).toEqual([1, 4]);
    expect(gaps).toEqual([2]);
    expect(resumed.snapshot()).toMatchObject({ deduplicated: 1, gapReports: [{ sequenceKnown: true, fromSequence: 2, toSequence: 3 }] });
    await resumed.stop();
  });

  it("new instance resumes an atomic checkpoint and keeps other connections isolated", async () => {
    const { dataDir, store } = await fixture();
    expect(await store.load(checkpoint(1).connectionId)).toBeNull();
    await store.save(checkpoint(7));
    const next = new FileSubscriptionCheckpointStore(dataDir);
    expect(await next.load(checkpoint(1).connectionId)).toEqual(checkpoint(7));
    expect(await next.load("other-project:line/1")).toBeNull();
    await next.clear(checkpoint(1).connectionId);
    expect(await store.load(checkpoint(1).connectionId)).toBeNull();
  });

  it("serializes racing writes, then clear, without resurrecting older positions", async () => {
    const { store } = await fixture();
    await Promise.all([store.save(checkpoint(1)), store.save(checkpoint(2)), store.save(checkpoint(3))]);
    expect((await store.load(checkpoint(1).connectionId))?.lastSequence).toBe(3);
    await Promise.all([store.save(checkpoint(4)), store.clear(checkpoint(1).connectionId)]);
    expect(await store.load(checkpoint(1).connectionId)).toBeNull();
  });

  it("fails closed for corrupted content and a mismatched connection", async () => {
    const { dataDir, store } = await fixture();
    await store.save(checkpoint(1));
    const directory = path.join(dataDir, "subscription-checkpoints");
    const fs = await import("node:fs/promises");
    const [name] = await fs.readdir(directory);
    const file = path.join(directory, name!);
    await writeFile(file, "{broken");
    await expect(store.load(checkpoint(1).connectionId)).rejects.toThrow("文件损坏");
    await writeFile(file, JSON.stringify({ ...checkpoint(2), connectionId: "another" }));
    await expect(store.load(checkpoint(1).connectionId)).rejects.toThrow("归属无效");
    expect((await readFile(file, "utf8"))).toContain("another");
  });

  it("rejects malformed positions and traversal IDs cannot leave dataDir", async () => {
    const { dataDir, store } = await fixture();
    await expect(store.save({ ...checkpoint(2), lastSequence: Number.NaN })).rejects.toThrow("位置无效");
    const traversal = { ...checkpoint(2), connectionId: "../../outside" };
    await store.save(traversal);
    expect(await new FileSubscriptionCheckpointStore(dataDir).load(traversal.connectionId)).toEqual(traversal);
  });
});
