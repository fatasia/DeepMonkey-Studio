import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const login = await fetch("http://127.0.0.1:4100/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:"admin",password:"admin"})});
const {token}=await login.json();
const b = await playwright.chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:true,args:["--enable-unsafe-webgpu","--no-sandbox"]});
const ctx = await b.newContext({viewport:{width:1280,height:800}});
await ctx.addInitScript(({token})=>{localStorage.setItem("bim-studio-auth-token",token);},{token});
const p = await ctx.newPage();
p.on("pageerror",e=>console.log("PAGEERR",e.message.slice(0,300)));
await p.goto("http://127.0.0.1:5173/",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(3000);
const urls = JSON.parse(process.env.URLS);
const out = await p.evaluate(async (urls) => {
  const norm = await import("/src/viewer/studioWasmRuntimePackage.ts");
  const gltf = await import("/@fs/D:/Documents/bim/bim-studio/packages/deep-engine/src/gltf/index.ts");
  const dec = await import("/src/delivery/browserImageDecoder.ts");
  const res = [];
  for (const u of urls) {
    const raw = new Uint8Array(await (await fetch(u)).arrayBuffer());
    const bytes = await norm.normalizeStudioWasmModel(raw, new AbortController().signal);
    const r = { u: u.split("/models/")[1].slice(0,8), raw: raw.length, norm: bytes.length };
    try {
      const d = await gltf.decodeDeformablePacketGlb(bytes, dec.browserImageDecoder, { resourcePrefix: "t", liveDeformation: true });
      r.mode = d.mode; r.features = d.features; r.fallback = d.fallbackReason; r.geoms = d.packet.geometries.length; r.inst = d.packet.instances.length;
    } catch (e) { r.err = String(e.message ?? e).slice(0, 300); }
    try {
      const parsed = gltf.parseGlb(bytes);
      const doc = parsed.json;
      r.prims = doc.meshes.map(m => m.primitives.map(p => Object.keys(p.attributes).join(",") + (p.targets? "+targets":"")));
    } catch {}
    res.push(r);
  }
  return res;
}, urls);
console.log(JSON.stringify(out, null, 1));
await b.close();


