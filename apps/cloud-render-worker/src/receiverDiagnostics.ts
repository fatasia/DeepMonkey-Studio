/** 此函数同时嵌入独立 Viewer；保持闭包独立，只导出 RTC 数值白名单。 */
export function collectReceiverDiagnostics(rows: Array<Record<string, unknown>>, playback: Record<string, number>) {
  const inbound: Array<Record<string, unknown>> = [];
  const network: Array<Record<string, number>> = [];
  for (const row of rows) {
    if (row.type === "inbound-rtp" && (row.kind === "video" || row.mediaType === "video")) {
      const record: Record<string, unknown> = {};
      for (const key of ["frameWidth", "frameHeight", "framesPerSecond", "framesReceived", "framesDecoded", "framesDropped", "packetsReceived", "packetsLost", "bytesReceived", "jitter", "totalDecodeTime", "totalProcessingDelay", "jitterBufferDelay", "jitterBufferEmittedCount", "freezeCount", "totalFreezesDuration"])
        if (typeof row[key] === "number" && Number.isFinite(row[key])) record[key] = row[key];
      for (const codec of rows) if (codec.type === "codec" && codec.id === row.codecId && typeof codec.mimeType === "string") record.codec = codec.mimeType;
      if (typeof row.decoderImplementation === "string") record.decoderImplementation = row.decoderImplementation;
      if (typeof row.powerEfficientDecoder === "boolean") record.powerEfficientDecoder = row.powerEfficientDecoder;
      inbound.push(record);
    }
    if (row.type === "candidate-pair" && row.state === "succeeded" && row.nominated === true) {
      const record: Record<string, number> = {};
      for (const key of ["currentRoundTripTime", "totalRoundTripTime", "availableIncomingBitrate", "availableOutgoingBitrate", "bytesReceived", "bytesSent", "responsesReceived"])
        if (typeof row[key] === "number" && Number.isFinite(row[key])) record[key] = row[key] as number;
      network.push(record);
    }
  }
  const video: Record<string, number> = {};
  for (const key of ["width", "height", "readyState", "totalVideoFrames", "droppedVideoFrames"])
    if (typeof playback[key] === "number" && Number.isFinite(playback[key])) video[key] = playback[key];
  return { schemaVersion: 1, kind: "cloud-render-receiver", createdAt: new Date().toISOString(),
    units: { rtcTime: "seconds", frameRate: "frames/second", bitrate: "bits/second", data: "bytes" }, playback: video, inbound, network };
}
