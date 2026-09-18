import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const root=path.dirname(new URL(import.meta.url).pathname), port=+(process.env.PORT||4179);
http.createServer((req,res)=>{const f=path.join(root, decodeURIComponent(req.url.split("?")[0]||"/runner.html")); try {const b=fs.readFileSync(f);res.writeHead(200,{"content-type":f.endsWith(".js")?"text/javascript":"text/html"});res.end(b)} catch {res.writeHead(404);res.end("not found")}}).listen(port,()=>console.log(`http://127.0.0.1:${port}/runner.html`));
