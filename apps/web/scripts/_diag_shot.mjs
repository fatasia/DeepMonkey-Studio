import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import sharp from "sharp";
const login = await fetch("http://127.0.0.1:4100/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:"admin",password:"admin"})});
const {token}=await login.json();
const b = await playwright.chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:true,args:["--enable-unsafe-webgpu","--enable-features=Vulkan,UseSkiaRenderer","--no-sandbox"]});
const ctx = await b.newContext({viewport:{width:1920,height:1080}});
const pref = process.env.PREF ?? "webgpu";
await ctx.addInitScript(({token,pref})=>{localStorage.setItem("bim-studio-auth-token",token);localStorage.setItem("bim-studio.renderer-backend",pref);},{token,pref});
const p = await ctx.newPage();
p.on("console",m=>{ if(/\[Deep\]/.test(m.text())) console.log("CONSOLE", m.text().slice(0,300)); });
p.on("pageerror",e=>console.log("PAGEERR",e.message.slice(0,300)));
await p.goto("http://127.0.0.1:5173/studio/776cf382-8d4b-4740-8de4-167d1d4d4632?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1",{waitUntil:"domcontentloaded"});
const deadline = Date.now()+120000;
while (Date.now()<deadline) { const ok = await p.evaluate(()=>performance.getEntriesByType("mark").some(m=>m.name==="deep-webgpu:published")); if (pref!=="webgpu"||ok) break; await p.waitForTimeout(1000); }
await p.waitForTimeout(3000);
console.log("SYNC", JSON.stringify(await p.evaluate(()=>performance.getEntriesByType("mark").filter(m=>/deformation-sync|published/.test(m.name)).map(m=>m.name))));
console.log("buttons", JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll(".viewport button, [class*=toolbar] button")].slice(0,14).map(b=>b.getAttribute("aria-label")||b.title||b.textContent.trim()))));
const out = process.env.OUTDIR ?? "../../test-output/anim-probe";
if (process.env.SELECT) { await p.locator("text="+process.env.SELECT).first().click(); await p.waitForTimeout(800); }
const fit = p.getByLabel(/适应|聚焦|全景|复位/).first();
try { await fit.click({timeout:3000}); console.log("fit clicked"); } catch { console.log("no fit button"); }
await p.waitForTimeout(2500);
const clip = {x:248,y:52,width:1368,height:1028};
const shots = [];
for (let i=0;i<4;i++){ const buf = await p.screenshot({clip}); shots.push(buf); if(i===0) await p.screenshot({path:`${out}/deep-frame0.png`}); await p.waitForTimeout(600); }
const raws = await Promise.all(shots.map(s=>sharp(s).raw().toBuffer()));
for (let i=1;i<raws.length;i++){ let diff=0; for(let k=0;k<raws[0].length;k+=4){ if (Math.abs(raws[0][k]-raws[i][k])+Math.abs(raws[0][k+1]-raws[i][k+1])+Math.abs(raws[0][k+2]-raws[i][k+2])>24) diff++; } console.log("frame",i,"changed px",diff); }
await p.screenshot({path:`${out}/deep-frame3.png`});
await b.close();


