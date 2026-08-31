type CaptureCount = 1 | 2 | 3;

type RouteCaptures<N extends CaptureCount> = N extends 1
  ? readonly [string]
  : N extends 2
    ? readonly [string, string]
    : readonly [string, string, string];

/**
 * 路由正则与捕获组数量在同一处声明。数量不符时视为未匹配，避免本地适配器
 * 因错误的非空断言把空 ID 写入工作区。
 */
export function matchRoute<N extends CaptureCount>(
  pathname: string,
  pattern: RegExp,
  captureCount: N,
): RouteCaptures<N> | undefined {
  const result = pathname.match(pattern);
  if (!result) return undefined;
  const captures = result.slice(1);
  if (captures.length !== captureCount || captures.some((item) => item === undefined)) return undefined;
  return captures.map((item) => decodeURIComponent(item)) as unknown as RouteCaptures<N>;
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function emptyResponse(): Response {
  return new Response(null, { status: 204 });
}

export function badRequest(message: string): Response { return jsonResponse({ message }, 400); }
export function notFound(message: string): Response { return jsonResponse({ message }, 404); }
export function conflict(message: string): Response { return jsonResponse({ message }, 409); }
export function methodNotAllowed(): Response { return jsonResponse({ message: "本地工作台不支持该请求方法" }, 405); }
export function serverOnly(path: string): Response {
  return jsonResponse({ message: `“${path}”需要连接在线服务器；本地工作台不会伪造云端、AI 或工业数据服务` }, 409);
}
