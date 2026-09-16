import { chartFrame } from "../../../apps/web/src/delivery/dashboardChartFrame.js";
import type { DashboardRuntimeV1 } from "../src/runtimePackage/dashboardCompositionTypes.js";
import type { DeepRuntimePackageV5 } from "../src/runtimePackage/types.js";
import { runDashboardCompositionProbe } from "./dashboardCompositionProbe.js";

const output = document.querySelector<HTMLElement>("#output")!;
const surface = document.querySelector<HTMLElement>("#surface")!;
const controls = document.querySelector<HTMLFieldSetElement>("#controls")!;
const pages = document.querySelector<HTMLElement>("#pages")!;
const tick = document.querySelector<HTMLButtonElement>("#tick")!;
const diagnostics = document.querySelector<HTMLButtonElement>("#diagnostics")!;
const source = document.querySelector<HTMLElement>("#package-source")!;

function sameOriginPackageUrl(): URL {
  const requested = new URLSearchParams(location.search).get("package") ?? "./dashboard-composition-v1.json";
  const url = new URL(requested, location.href);
  if (url.origin !== location.origin) throw new Error("Dashboard package URL must use the probe origin.");
  return url;
}

async function loadPackage(url: URL): Promise<DeepRuntimePackageV5> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin",
    headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Dashboard package fetch failed (${response.status}).`);
  return await response.json() as DeepRuntimePackageV5;
}

function messages(value: unknown): unknown {
  return value instanceof AggregateError ? { message: value.message, causes: value.errors.map(messages) }
    : value instanceof Error ? { name: value.name, message: value.message } : String(value);
}

async function start() {
  const packageUrl = sameOriginPackageUrl(); source.textContent = `${packageUrl.pathname}${packageUrl.search}`;
  const runtime = await loadPackage(packageUrl);
  const dashboard = runtime.payloads[runtime.entrypoints.dashboard] as unknown as DashboardRuntimeV1;
  const probe = await runDashboardCompositionProbe(surface, runtime, chartFrame);
  let elapsedMs = 0;
  const render = (action: string, result: unknown = probe.initial) => {
    output.textContent = JSON.stringify({ action, packageUrl: packageUrl.href, result,
      identity: probe.page?.identity, surfaces: probe.surfaces, diagnostics: probe.diagnostics }, null, 2);
    for (const button of pages.querySelectorAll<HTMLButtonElement>("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.pageId === probe.page?.identity.pageId));
    }
  };
  const act = async (action: string, work: () => Promise<unknown>) => {
    controls.disabled = true; controls.setAttribute("aria-busy", "true");
    try { render(action, await work()); }
    catch (error) { output.textContent = JSON.stringify({ action, error: messages(error) }, null, 2); }
    finally { controls.disabled = false; controls.removeAttribute("aria-busy"); }
  };
  dashboard.pages.forEach((page, index) => {
    const button = window.document.createElement("button"); button.type = "button";
    button.textContent = `Page ${index + 1}`; button.title = page.id; button.dataset.pageId = page.id;
    button.addEventListener("click", () => void act(`page:${page.id}`, () => probe.pageId(page.id)));
    pages.append(button);
  });
  tick.addEventListener("click", () => void act(`tick:${elapsedMs += 100}`, () => probe.tick(elapsedMs)));
  diagnostics.addEventListener("click", () => render("diagnostics"));
  Object.assign(globalThis, { dashboardProbe: probe, dashboardPackage: runtime, dashboardPackageUrl: packageUrl.href });
  controls.disabled = false; render("initial");
}

start().catch(error => {
  output.textContent = JSON.stringify({ error: messages(error) }, null, 2);
  Object.assign(globalThis, { dashboardProbeError: messages(error) });
});
