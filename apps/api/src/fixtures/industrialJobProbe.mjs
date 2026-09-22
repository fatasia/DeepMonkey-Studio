import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "parent") {
  const [hostPath, pidFile] = process.argv.slice(3);
  const host = spawn(hostPath, [], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
  host.stdin.on("error", () => {});
  host.stdin.write(JSON.stringify({ parentPid: process.pid, executable: process.execPath,
    arguments: [fileURLToPath(import.meta.url)], payload: { mode: "tree", pidFile },
    maxMemoryMb: 512, timeoutMs: 30000, maxCpuPercent: 100 }) + "\n");
  console.log(JSON.stringify({ hostPid: host.pid, parentPid: process.pid }));
  setInterval(() => {}, 1000);
} else {
  let input = "";
  process.stdin.on("data", bytes => { input += bytes; });
  process.stdin.on("end", () => {
    const { mode, pidFile } = JSON.parse(input);
    let descendant;
    if (mode === "tree") descendant = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "inherit" });
    writeFileSync(pidFile, JSON.stringify({ workerPid: process.pid, descendantPid: descendant?.pid }));
    if (mode === "cpu") while (true) {}
    if (mode === "memory") { const retained = []; while (true) retained.push(Buffer.alloc(16 * 1024 * 1024, 1)); }
    if (mode === "crash") process.exit(23);
    if (mode === "result") { console.log(JSON.stringify({ ok: true })); return; }
    setInterval(() => {}, 1000);
  });
}
