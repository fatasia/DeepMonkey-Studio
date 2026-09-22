process.once("message", request => {
  if (request.sourceName === "crash") process.exit(23);
  if (request.sourceName === "protocol") { process.send({ type: "result", value: {} }); return; }
  process.send({ type: "started" });
  while (true) { /* CPU-bound reader failure injection, terminated by parent PID. */ }
});
