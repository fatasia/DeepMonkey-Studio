import type { AuthorModelDecoder } from "./authorModelDecode";
import { createAuthorModelWorkerDecoder, type AuthorModelWorkerHost } from "./authorModelWorkerClient";

/** Author-only opt-in; Node, SDK and custom decoder consumers retain their original path. */
export const browserAuthorModelDecoder: AuthorModelDecoder | undefined =
  typeof document !== "undefined" && typeof Worker !== "undefined"
    ? createAuthorModelWorkerDecoder(() => new Worker(new URL("./authorModelDecode.worker.ts", import.meta.url),
      { type: "module", name: "studio-author-model" }) as unknown as AuthorModelWorkerHost)
    : undefined;
