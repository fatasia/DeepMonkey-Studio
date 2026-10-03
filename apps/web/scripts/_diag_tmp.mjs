import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const login = await fetch("http://127.0.0.1:4100/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:"admin",password:"admin"})});
const {token}=await login.json();
const b = await playwright.chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:true,args:["--enable-unsafe-webgpu","--enable-features=Vulkan,UseSkiaRenderer","--no-sandbox"]});
const ctx = await b.newContext({viewport:{width:1920,height:1080}});
const pref = process.env.PREF ?? "webgpu";
await ctx.addInitScript(({token,pref})=>{localStorage.setItem("bim-studio-auth-token",token);localStorage.setItem("bim-studio.renderer-backend",pref);},{token,pref});
const p = await ctx.newPage();
p.on("framenavigated",f=>{ if(f===p.mainFrame()) console.log("NAV", f.url().slice(0,60)); });
p.on("console",m=>{ const t=m.text(); if(m.type()==="error" && !/Failed to load resource/.test(t) || /Deep|WebGPU/.test(t)) console.log(m.type(), t.slice(0,500)); });
p.on("pageerror",e=>console.log("PAGEERR",e.message.slice(0,500)));
await p.goto("http://127.0.0.1:5173/studio/776cf382-8d4b-4740-8de4-167d1d4d4632?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(Number(process.env.WAIT_MS ?? 25000));
console.log("MARKS", JSON.stringify(await p.evaluate(()=>performance.getEntriesByType("mark").filter(m=>/deep|packet|switch/i.test(m.name)).map(m=>m.name+"@"+Math.round(m.startTime)))));console.log("MARKS", JSON.stringify(await p.evaluate(()=>performance.getEntriesByType("mark").filter(m=>/deep|packet|switch/i.test(m.name)).map(m=>m.name+"@"+Math.round(m.startTime)))));
console.log("canvases", JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll("canvas")].map(c=>c.getAttribute("data-renderer-backend")+":"+c.style.visibility+":"+c.style.opacity))));
try { await p.getByLabel("更多场景工具", { exact: true }).click({timeout:5000}); await p.getByRole("button", { name: "渲染引擎设置", exact: true }).click({timeout:5000});
  const d = p.getByRole("dialog", { name: "渲染引擎设置", exact: true }); await d.waitFor({timeout:5000}); console.log("DIALOG:", (await d.innerText()).slice(0,1200)); await p.keyboard.press("Escape"); } catch(e){ console.log("dialog err", e.message.slice(0,100)); }
await p.screenshot({path: process.env.OUT ?? "../../test-output/anim-probe/deep.png"});
await b.close();

