import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import fixture from "../../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { assertDashboardWebPackage, dashboardWebPath } from "./dashboardWebPackage";
import { loadDashboardWebPackage } from "./dashboardWebPackageLoader";

const sha=(data:Uint8Array)=>createHash("sha256").update(data).digest("hex");
function sample() {
  const application=structuredClone(fixture.application);
  application.scripts=[];application.scenes=[];application.interactions=[];
  application.pages=application.pages.slice(0,1);application.pages[0]!.nodes=[];
  const publication={id:"published",applicationId:application.metadata.id,projectId:application.metadata.projectId,
    applicationRevision:application.metadata.revision,document:application,publishedAt:"2026-09-17T00:00:00Z"};
  const bytes=new Uint8Array([1,2,3]);
  const body={schema:"deep-monkey.dashboard-web",schemaVersion:1,publication,publicationSha256:runtimeContentSha256(publication),
    entryPageId:application.pages[0]!.id,runtimeFiles:[{path:"assets/runtime.js",bytes:3,sha256:sha(bytes)}],resources:
    [400,700].map(weight=>({sourceUrl:`font:${weight}`,path:`resources/font-${weight}`,mime:"font/ttf",bytes:3,sha256:sha(bytes),
      font:{weight,style:"normal",licenseEvidence:"test-only font identity",licensePath:"assets/runtime.js"}}))};
  return {...body,contentSha256:runtimeContentSha256(body)};
}
const seal=(value:ReturnType<typeof sample>)=>{
  value.publicationSha256=runtimeContentSha256(value.publication);
  const {contentSha256:_,...body}=value;value.contentSha256=runtimeContentSha256(body);return value;
};
describe("independent static Dashboard package",()=>{
  it("requires exact publication and same-revision entry",()=>{
    expect(()=>assertDashboardWebPackage(sample())).not.toThrow();
    const value=sample();value.publication.applicationRevision++;
    expect(()=>assertDashboardWebPackage(seal(value))).toThrow(/身份/);
  });
  it("rejects missing fonts, missing resource closure, scripts and unsupported entry",()=>{
    const missing=sample();missing.resources=[];expect(()=>assertDashboardWebPackage(seal(missing))).toThrow(/字体/);
    const resource=sample();Object.assign(resource.publication.document.pages[0]!,{appearance:{backgroundImageUrl:"https://example.invalid/bg.png"}});
    expect(()=>assertDashboardWebPackage(seal(resource))).toThrow(/资源未冻结/);
    const script=sample();(script.publication.document.scripts as unknown[]).push({id:"unfrozen"});
    expect(()=>assertDashboardWebPackage(seal(script))).toThrow();
    const entry=sample();entry.entryPageId="missing";expect(()=>assertDashboardWebPackage(seal(entry))).toThrow(/入口/);
  });
  it("rejects traversal, duplicates, budget overflow and self-hash changes",()=>{
    for(const value of ["../file","/file","assets//file","https://x/file","a/%2e/file","a\\b"])
      expect(dashboardWebPath(value)).toBe(false);
    const duplicate=sample();duplicate.runtimeFiles.push(duplicate.runtimeFiles[0]!);
    expect(()=>assertDashboardWebPackage(seal(duplicate))).toThrow(/路径/);
    const budget=sample();budget.runtimeFiles[0]!.bytes=65*1024*1024;
    expect(()=>assertDashboardWebPackage(seal(budget))).toThrow(/预算/);
    const changed=sample();changed.contentSha256="0".repeat(64);expect(()=>assertDashboardWebPackage(changed)).toThrow(/摘要/);
  });
  it("loads only relative package files and rejects modified bytes, cancellation and unsupported protocol",async()=>{
    const manifest=sample(),seen:string[]=[];
    const fetcher=(async(input:RequestInfo|URL)=>{const url=String(input);seen.push(url);
      return url.endsWith("dashboard.web.json") ? new Response(JSON.stringify(manifest)) : new Response(new Uint8Array([1,2,3]));}) as typeof fetch;
    const loaded=await loadDashboardWebPackage(new URL("https://static.invalid/sub/app/"),new AbortController().signal,fetcher);
    expect(loaded.resources.size).toBe(2);expect(seen.every(url=>url.startsWith("https://static.invalid/sub/app/"))).toBe(true);
    const corrupt=(async(input:RequestInfo|URL)=>String(input).endsWith("dashboard.web.json")
      ? new Response(JSON.stringify(manifest)) : new Response(new Uint8Array([3,2,1]))) as typeof fetch;
    await expect(loadDashboardWebPackage(new URL("https://static.invalid/sub/app/"),new AbortController().signal,corrupt)).rejects.toThrow(/校验失败/);
    await expect(loadDashboardWebPackage(new URL("https://static.invalid/"),AbortSignal.abort(),fetcher)).rejects.toThrow();
    await expect(loadDashboardWebPackage(new URL("file:///C:/app/"),new AbortController().signal,fetcher)).rejects.toThrow(/HTTP/);
  });
});
