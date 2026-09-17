import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { dashboardBackgroundStyle } from "../apps/web/src/components/dashboardCanvasStyle.ts";
import { rasterizeFrozenPageBackground } from "./lib/dashboardRasterHost.mjs";

const output = path.resolve(process.argv[2] ?? "test-output/dashboard-page-background");
await mkdir(output, { recursive: true });
const css = await readFile("apps/web/src/styles/base.css", "utf8");
const pixels = Buffer.alloc(64 * 32 * 4);
for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
  const at = (y * 64 + x) * 4;
  pixels.set(x < 32 ? [62,198,193,255] : [216,172,82,y < 16 ? 128 : 255], at);
}
const source = await sharp(pixels, {raw:{width:64,height:32,channels:4}}).png().toBuffer();
const asset = {bytes:source,sha256:createHash("sha256").update(source).digest("hex"),mime:"image/png"};
const images = new Map<string,Buffer>([["/source.png",source]]);
const cases: {key:string;style:ReturnType<typeof dashboardBackgroundStyle>;width:number;height:number}[] = [];
for (const width of [240,239]) for (const fit of ["cover","contain","stretch","original"] as const)
  for (const position of ["center","top","bottom","left","right"] as const) for(const repeat of [false,true]) {
    const height = width === 240 ? 160 : 159;
    const background = {fit,position,repeat}, key = `${width}-${fit}-${position}-${repeat}`;
    const result = await rasterizeFrozenPageBackground({width,height,fit:"fill",background,asset,requestHash:key});
    const png = await sharp(result.rgba,{raw:{width,height,channels:4}}).png().toBuffer();
    images.set(`/${key}.png`,png);
    await writeFile(path.join(output,`${key}.png`),png);
    cases.push({key,width,height,style:dashboardBackgroundStyle({backgroundImageUrl:"/source.png",
      backgroundImageFit:fit,backgroundImagePosition:position,backgroundImageRepeat:repeat})});
  }
const cssName = (key:string) => key.replace(/[A-Z]/g,match=>`-${match.toLowerCase()}`);
const server = createServer((req,res)=>{
  const url = new URL(req.url ?? "/","http://127.0.0.1");
  if(url.pathname === "/base.css") {res.setHeader("content-type","text/css");res.end(css);return;}
  const image = images.get(url.pathname);
  if(image) {res.setHeader("content-type","image/png");res.end(image);return;}
  if(url.pathname !== "/") {res.writeHead(404).end();return;}
  const width = url.searchParams.get("odd") === "1" ? 239 : 240;
  const position = url.searchParams.get("position") ?? "center";
  const theme = url.searchParams.get("theme") === "light" ? "light" : "dark";
  const fit = url.searchParams.get("fit");
  const rows=cases.filter(item=>item.width===width && item.key.includes(`-${position}-`)
    && (!fit || item.key.includes(`-${fit}-`)));
  res.setHeader("content-type","text/html");
  res.end(`<!doctype html><html data-theme="${theme}"><meta charset="utf-8"><title>Page background parity</title>
    <link rel="stylesheet" href="/base.css"><style>body{padding:24px;color:var(--text);background:var(--bg-0);font:13px sans-serif}
    main{display:grid;grid-template-columns:repeat(2,max-content);gap:24px}figure{margin:0}section{display:flex;gap:8px}
    figcaption{margin-bottom:8px}img,.reference{display:block} .raster{background:${dashboardBackgroundStyle(undefined).backgroundColor}}
    @media(max-width:1050px){main{grid-template-columns:max-content}}h1{font-size:18px;color:var(--text-strong)}</style>
    <h1>Page background · CSS / frozen raster · ${position}</h1><main>${rows.map(item=>`<figure><figcaption>${item.key}</figcaption>
    <section><div class="reference" style="width:${item.width}px;height:${item.height}px;${Object.entries(item.style)
      .map(([key,value])=>`${cssName(key)}:${String(value).replaceAll('"','&quot;')}`).join(';')}"></div>
    <img class="raster" width="${item.width}" height="${item.height}" src="/${item.key}.png"></section></figure>`).join("")}</main></html>`);
});
server.listen(5293,"127.0.0.1",()=>console.log("Page background preview: http://127.0.0.1:5293"));
