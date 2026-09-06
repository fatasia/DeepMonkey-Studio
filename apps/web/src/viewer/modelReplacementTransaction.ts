interface ReplacementTransaction<T> {
  detachPrevious: () => void;
  installCandidate: () => T;
  discardCandidate: () => void;
  restorePrevious: () => void;
  releasePrevious: () => void;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 候选提交前旧资源仅脱离运行态；候选提交异常不触发旧资源销毁。 */
export function commitModelReplacement<T>(transaction: ReplacementTransaction<T>): T {
  let result: T;
  try {
    transaction.detachPrevious();
    result = transaction.installCandidate();
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try { transaction.discardCandidate(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { transaction.restorePrevious(); }
    catch (rollbackError) {
      throw new AggregateError([error, ...cleanupErrors, rollbackError],
        `素材替换失败，原实例回滚也失败，请重新载入已保存场景：${message(rollbackError)}`);
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors],
      `素材替换失败，原实例已恢复，但候选资源清理失败：${message(cleanupErrors[0])}`);
    throw new Error(`素材替换失败，原实例已恢复：${message(error)}`, { cause: error });
  }
  // 销毁是提交后的资源清理，不纳入回滚：资源释放可能已部分完成。
  transaction.releasePrevious();
  return result;
}
