import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
const root=path.resolve(process.argv[2] ?? ""),prefix="/nested/dashboard/";
const types={".html":"text/html; charset=utf-8",".js":"text/javascript",".css":"text/css",".json":"application/json",".wasm":"application/wasm"};
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,"http://127.0.0.1");
  console.log(`${req.method} ${url.pathname}`);
  if(url.pathname==="/preview") {
    const width=url.searchParams.get("width")==="480" ? 480 : 980;
    res.setHeader("content-type","text/html");
    res.end(`<!doctype html><title>Static package responsive verification</title><iframe title="静态发布包" style="border:0;width:${width}px;height:720px" src="${prefix}?theme=light"></iframe>`);return;
  }
  if(url.pathname==="/favicon.ico") {res.writeHead(204).end();return;}
  if(!url.pathname.startsWith(prefix) || req.method!=="GET") {res.writeHead(404).end();return;}
  const relative=decodeURIComponent(url.pathname.slice(prefix.length)) || "index.html";
  const file=path.resolve(root,relative);
  if(!file.startsWith(`${root}${path.sep}`)) {res.writeHead(400).end();return;}
  try {res.setHeader("content-type",types[path.extname(file)] ?? "application/octet-stream");res.setHeader("cache-control","no-store");res.end(await readFile(file));}
  catch {res.writeHead(404).end();}
});
server.listen(5294,"127.0.0.1",()=>console.log(`Static only: http://127.0.0.1:5294${prefix}`));
