interface RequestSource {
  readonly aborted?: boolean;
  once(event: "aborted", listener: () => void): unknown;
  removeListener(event: "aborted", listener: () => void): unknown;
}

interface ResponseSource {
  readonly destroyed?: boolean;
  readonly writableFinished?: boolean;
  once(event: "close", listener: () => void): unknown;
  removeListener(event: "close", listener: () => void): unknown;
}

/** IncomingMessage 在正文读完后不再触发 aborted；等待响应期间断开要看 ServerResponse.close。 */
export function httpDisconnectScope(request?: RequestSource, response?: ResponseSource) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("HTTP 客户端已断开"));
  const closed = () => { if (!response?.writableFinished) abort(); };
  request?.once("aborted", abort);
  response?.once("close", closed);
  if (request?.aborted || (response?.destroyed && !response.writableFinished)) abort();
  return {
    signal: controller.signal,
    dispose() {
      request?.removeListener("aborted", abort);
      response?.removeListener("close", closed);
    },
  };
}
