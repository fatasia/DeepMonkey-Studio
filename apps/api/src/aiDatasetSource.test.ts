import type {
  DataConnectionRecord,
  DataConnectionType,
  DataDatasetRecord,
} from "@bim-studio/contracts";
import type { DataQuerySource } from "@bim-studio/data-query-plugin";
import { describe, expect, it } from "vitest";
import { readAiDataset } from "./aiDatasetSource.js";
import type { MetadataStore } from "./metadataStore.js";

const PROJECT_ID = "project-1";

describe("readAiDataset", () => {
  it.each<DataConnectionType>(["postgresql", "http", "kafka"])(
    "reads %s datasets through the shared query source and records provenance",
    async (connectionType) => {
      const dataset = datasetRecord(`dataset-${connectionType}`, `connection-${connectionType}`);
      const connection = connectionRecord(dataset.connectionId, connectionType);
      const signal = new AbortController().signal;
      let receivedSignal: AbortSignal | undefined;
      const source = dataQuerySource(dataset, async (_projectId, _datasetId, currentSignal) => {
        receivedSignal = currentSignal;
        return {
          dataset,
          fields: dataset.fields,
          rows: [
            {
              temperature: 36.5,
              current: "12.4",
              healthy: true,
              capturedAt: new Date("2026-08-31T08:00:00.000Z"),
              ignored: { nested: true },
            },
          ],
          durationMs: 6.7,
        };
      });

      const snapshot = await readAiDataset(
        source,
        metadataStore([connection]),
        PROJECT_ID,
        dataset.id,
        signal,
      );

      expect(receivedSignal).toBe(signal);
      expect(snapshot.records).toEqual([
        {
          temperature: 36.5,
          current: "12.4",
          healthy: 1,
          capturedAt: "2026-08-31T08:00:00.000Z",
        },
      ]);
      expect(snapshot.numericRows).toEqual([{ temperature: 36.5, current: 12.4, healthy: 1 }]);
      expect(snapshot.evidence).toMatchObject({
        datasetId: dataset.id,
        datasetName: dataset.name,
        connectionId: connection.id,
        connectionType,
        rowCount: 1,
        fieldKeys: ["temperature", "current", "healthy", "capturedAt"],
        durationMs: 7,
      });
      expect(Number.isNaN(Date.parse(snapshot.evidence.sampledAt))).toBe(false);
    },
  );

  it("rejects disabled connections, empty datasets, and rows without scalar model fields", async () => {
    const dataset = datasetRecord("telemetry", "connection-1");
    const disabled = connectionRecord(dataset.connectionId, "mqtt", false);
    const source = dataQuerySource(dataset, async () => ({
      dataset,
      fields: dataset.fields,
      rows: [{ temperature: 36 }],
      durationMs: 1,
    }));

    await expect(readAiDataset(
      source,
      metadataStore([disabled]),
      PROJECT_ID,
      dataset.id,
      new AbortController().signal,
    )).rejects.toThrow("已停用");

    const enabledStore = metadataStore([{ ...disabled, enabled: true }]);
    const emptySource = dataQuerySource(dataset, async () => ({
      dataset,
      fields: dataset.fields,
      rows: [],
      durationMs: 1,
    }));
    await expect(readAiDataset(
      emptySource,
      enabledStore,
      PROJECT_ID,
      dataset.id,
      new AbortController().signal,
    )).rejects.toThrow("没有可用于模型运行的记录");

    const nestedOnlySource = dataQuerySource(dataset, async () => ({
      dataset,
      fields: dataset.fields,
      rows: [{ payload: { temperature: 36 } }],
      durationMs: 1,
    }));
    await expect(readAiDataset(
      nestedOnlySource,
      enabledStore,
      PROJECT_ID,
      dataset.id,
      new AbortController().signal,
    )).rejects.toThrow("不包含可用于模型运行的标量字段");
  });

  it("forwards cancellation to the underlying connector read", async () => {
    const dataset = datasetRecord("live-stream", "connection-1");
    const controller = new AbortController();
    const source = dataQuerySource(dataset, async (_projectId, _datasetId, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("数据源读取已取消")), { once: true });
      });
      throw new Error("unreachable");
    });

    const pending = readAiDataset(
      source,
      metadataStore([connectionRecord(dataset.connectionId, "kafka")]),
      PROJECT_ID,
      dataset.id,
      controller.signal,
    );
    controller.abort("客户端已断开");

    await expect(pending).rejects.toThrow("数据源读取已取消");
  });
});

function datasetRecord(id: string, connectionId: string): DataDatasetRecord {
  return {
    id,
    projectId: PROJECT_ID,
    connectionId,
    name: `${id} 数据集`,
    refreshSeconds: 10,
    fields: [
      { key: "temperature", label: "温度", type: "number" },
      { key: "current", label: "电流", type: "number" },
      { key: "healthy", label: "健康", type: "boolean" },
      { key: "capturedAt", label: "采集时间", type: "datetime" },
    ],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

function connectionRecord(
  id: string,
  type: DataConnectionType,
  enabled = true,
): DataConnectionRecord {
  return {
    id,
    projectId: PROJECT_ID,
    name: `${type} connection`,
    type,
    enabled,
    config: {},
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}

function metadataStore(connections: DataConnectionRecord[]): MetadataStore {
  return {
    listDataConnections: (projectId: string) => projectId === PROJECT_ID ? connections : [],
  } as MetadataStore;
}

function dataQuerySource(
  dataset: DataDatasetRecord,
  readDataset: DataQuerySource["readDataset"],
): DataQuerySource {
  return {
    listDatasets: (projectId) => projectId === PROJECT_ID ? [dataset] : [],
    getDataset: (projectId, datasetId) =>
      projectId === PROJECT_ID && datasetId === dataset.id ? dataset : undefined,
    readDataset,
  };
}
