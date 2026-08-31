/** 可重试分类让调度层只重试临时网络或服务端故障。 */
export class NotificationTransportError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = code,
  ) {
    super(message);
  }
}

export function isRetryableNotificationError(error: unknown): boolean {
  return error instanceof NotificationTransportError && error.retryable;
}
