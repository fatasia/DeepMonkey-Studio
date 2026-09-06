/** Real CDP Worker attachment for the isolated gate; no product debugging bridge. */
export async function attachWorkerDebugger(context, page) {
  const cdp = await context.newCDPSession(page);
  const targets = new Map();
  const pending = new Map();
  const errors = [];
  let sequence = 0;
  function send(sessionId, method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => {
        pending.delete(id); clearTimeout(timer); reject(error);
      });
    });
  }
  cdp.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
    const value = JSON.parse(message);
    if (value.id) {
      const request = pending.get(value.id);
      if (!request) return;
      pending.delete(value.id); clearTimeout(request.timer);
      if (value.error) request.reject(new Error(JSON.stringify(value.error)));
      else request.resolve(value.result ?? {});
      return;
    }
    const target = targets.get(sessionId);
    if (!target) return;
    if (value.method === "Debugger.scriptParsed") target.scripts.push(value.params);
    if (value.method === "Debugger.paused") target.pauses.push(value.params);
    if (value.method === "Debugger.resumed") target.resumes++;
  });
  cdp.on("Target.attachedToTarget", event => {
    const target = { sessionId: event.sessionId, info: event.targetInfo, scripts: [], pauses: [], resumes: 0, detached: false };
    targets.set(event.sessionId, target);
    void (async () => {
      if (event.targetInfo.type === "worker" && event.targetInfo.url.includes("sceneBehavior.worker")) await send(event.sessionId, "Debugger.enable");
      await send(event.sessionId, "Runtime.runIfWaitingForDebugger");
    })().catch(error => { if (!target.detached) errors.push(String(error)); });
  });
  cdp.on("Target.detachedFromTarget", ({ sessionId }) => { const target = targets.get(sessionId); if (target) target.detached = true; });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
  return {
    targets, errors,
    send: (target, method, params) => send(target.sessionId, method, params),
    async source(url, previous) {
      return waitForValue(() => [...targets.values()].filter(target => !target.detached && target !== previous).flatMap(target => target.scripts.filter(script => script.url === url).map(script => ({ target, script })))[0], `Worker source ${url}`);
    },
    pause: (target, after = 0) => waitForValue(() => target.pauses[after], "Debugger.paused"),
    async close() {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("CDP gate closed")); }
      pending.clear(); await cdp.detach();
    },
  };
}

export async function waitForValue(read, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}
