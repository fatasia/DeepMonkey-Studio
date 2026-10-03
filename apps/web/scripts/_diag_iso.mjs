import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const login = await fetch("http://127.0.0.1:4100/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:"admin",password:"admin"})});
const {token}=await login.json();
const b = await playwright.chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:true,args:["--enable-unsafe-webgpu","--enable-features=Vulkan,UseSkiaRenderer","--no-sandbox"]});
const ctx = await b.newContext({viewport:{width:1920,height:1080}});
await ctx.addInitScript(({token})=>{localStorage.setItem("bim-studio-auth-token",token);localStorage.setItem("bim-studio.renderer-backend","webgl");},{token});
const p = await ctx.newPage();
p.on("console",m=>{ const t=m.text(); if(m.type()==="error" && !/Failed to load resource/.test(t) || /\[Deep|GPUValidation|validation/i.test(t)) console.log(m.type(), t.slice(0,600)); });
p.on("pageerror",e=>console.log("PAGEERR",e.message.slice(0,300)));
await p.goto("http://127.0.0.1:5173/studio/776cf382-8d4b-4740-8de4-167d1d4d4632?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1",{waitUntil:"domcontentloaded"});
await p.waitForTimeout(8000);
const keep = (process.env.KEEP ?? "").split(",").filter(Boolean).map(Number);
const rows = p.locator('[aria-label*="显示"], [title*="显示"], [title*="隐藏"]');
console.log("eye candidates", await rows.count());
// 行内眼睛按钮:左侧列表 5 个模型
const eyes = p.locator("aside, .scene-tree, body").first().locator('button:has(svg)').filter({ hasText: "" });
const names = ["SMT","掘进机","机械臂","painted-1","painted-2"];
for (let i=0;i<5;i++){ if (keep.includes(i)) continue;
  const row = p.locator(`text=${names[i]}`).first().locator("xpath=ancestor::*[self::li or self::div][.//button][1]");
  const btn = row.locator("button").first();
  try { await btn.click({timeout:3000}); console.log("hid", names[i]); } catch(e){ console.log("hide fail", names[i], e.message.slice(0,80)); } }
await p.waitForTimeout(1500);
await p.getByLabel("更多场景工具", { exact: true }).click();
await p.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
const d = p.getByRole("dialog", { name: "渲染引擎设置", exact: true });
await d.getByRole("button", { name: "启用 Deep WebGPU Beta", exact: true }).click();
const t0 = Date.now();
for (let i=0;i<24;i++){ await p.waitForTimeout(5000);
  const m = await p.evaluate(()=>performance.getEntriesByType("mark").filter(m=>/packet|runtime-ready/i.test(m.name)).map(m=>m.name.replace("deep-webgpu:","")+"@"+Math.round(m.startTime)));
  const txt = await d.innerText().catch(()=> "");
  const state = /已启用|切换未完成/.test(txt) ? txt.split("\n").filter(l=>/已启用|切换未完成|准备失败/.test(l)).join("|") : "";
  console.log(Math.round((Date.now()-t0)/1000)+"s", m.slice(-4).join(","), state);
  if (state) break; }
await p.screenshot({path: process.env.OUT ?? "../../test-output/anim-probe/iso.png"});
await b.close();
