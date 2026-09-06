import { assertPathSafeResourceId, type JsonValue } from "@bim-studio/contracts";
import {
  SCENE_API_VERSION, SceneBehaviorScheduler, parseSceneCommand,
  resolveSceneExtensionCompatibility, validateSceneCommand,
  type SceneCommand, type SceneExtensionManifest, type SceneHostCapabilities,
} from "@bim-studio/scene-sdk";
import { ServerClient, ServerRequestError, normalizeServerBaseUrl } from "@bim-studio/server-sdk";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkPureContracts() {
  assertPathSafeResourceId("consumer:scene-1");
  let unsafeRejected = false;
  try { assertPathSafeResourceId("../outside"); } catch { unsafeRejected = true; }
  check(unsafeRejected, "Resource IDs must reject traversal");
  const data: JsonValue = { energy: 12.5, unit: "kWh" };
  const command: SceneCommand = {
    id: "consumer:move", type: "object.set-transform",
    target: { kind: "object", sceneId: "scene:1", objectId: "device:1" }, position: [1, 2, 3],
  };
  const parsed = parseSceneCommand(command);
  command.position![0] = 99;
  check(parsed.type === "object.set-transform" && parsed.position?.[0] === 1, "Parsed commands must be detached");
  check(!validateSceneCommand({ ...command, position: [Infinity, 0, 0] }).valid, "Non-finite coordinates must fail");
  let getterReads = 0;
  const hostile = Object.defineProperty({}, "id", { enumerable: true, get: () => { getterReads++; return "unsafe"; } });
  check(!validateSceneCommand(hostile).valid && getterReads === 0, "Command validation must not execute accessors");
  return { apiVersion: SCENE_API_VERSION, commandType: parsed.type, data, rejectedInvalidCommand: true, detached: true };
}

function checkCompatibilityAndClock() {
  const manifest: SceneExtensionManifest = {
    id: "com.example.consumer", name: "Local consumer", version: "1.0.0", apiVersion: SCENE_API_VERSION,
    entry: "consumer.js", execution: "worker-sandbox", capabilities: ["studio.object"], permissions: ["scene.read"],
    hosts: ["browser"], renderers: ["webgl2"], lifecycle: ["onStart", "onUpdate", "onDispose"],
  };
  const host: SceneHostCapabilities = {
    apiVersion: SCENE_API_VERSION, host: "browser", renderer: "webgl2",
    capabilities: ["studio.object"], permissions: ["scene.read"], allowTrustedExtensions: false,
  };
  check(resolveSceneExtensionCompatibility(manifest, host).compatible, "Compatible extension must negotiate");
  const incompatible = resolveSceneExtensionCompatibility({ ...manifest, apiVersion: "2.0" }, host);
  check(incompatible.reasons.some(reason => reason.code === "api-major-mismatch"), "Future major must be rejected");
  const denied = resolveSceneExtensionCompatibility({ ...manifest, permissions: ["scene.write"] }, host);
  check(denied.reasons.some(reason => reason.code === "permission-denied"), "Unapproved permission must be rejected");
  const scheduler = new SceneBehaviorScheduler({ fixedStepMs: 10 });
  const ticks = scheduler.advance(25);
  check(ticks.map(tick => tick.lifecycle).join(",") === "onUpdate,onFixedUpdate,onFixedUpdate", "Deterministic lifecycle schedule");
  scheduler.pause(); check(scheduler.advance(100).length === 0, "Pause must not advance");
  scheduler.resume(); check(scheduler.advance(10).length === 2, "Resume must preserve fixed-step accumulator");
  scheduler.dispose(); check(scheduler.advance(10).length === 0, "Disposed scheduler must not advance");
  return { compatible: true, incompatibleMajorRejected: true, permissionRejected: true, lifecycleTicks: ticks.length, disposed: true };
}

async function checkServerTransport() {
  const requests: Array<{ pathname: string; method: string }> = [];
  const fixtureFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    check(url.origin === "https://consumer.invalid", "Fixture requests must remain same-origin");
    requests.push({ pathname: url.pathname, method: init?.method ?? "GET" });
    if (url.pathname === "/api/failure") return new Response(JSON.stringify({ message: "Fixture conflict", currentRevision: 7 }), { status: 409 });
    if (url.pathname === "/api/empty") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ ready: true }), { status: 200 });
  };
  const client = new ServerClient({ profile: { baseUrl: "https://consumer.invalid/base" }, fetch: fixtureFetch,
    authStore: { getAccessToken: () => undefined, setAccessToken: () => undefined, clearAccessToken: () => undefined } });
  check((await client.request<{ ready: boolean }>("/api/meta")).ready, "Public exported client must execute injected transport");
  check(await client.request<void>("/api/empty") === undefined, "204 must remain empty");
  const conflict: unknown = await client.request("/api/failure").catch(error => error);
  check(conflict instanceof ServerRequestError && conflict.status === 409, "Typed transport errors must survive package boundary");
  check((conflict.body as { currentRevision: number }).currentRevision === 7, "Conflict evidence must survive package boundary");
  const before = requests.length;
  const invalid: unknown = await client.request("https://outside.invalid/api/meta").catch(error => error);
  check(invalid instanceof TypeError && requests.length === before, "Cross-origin URL must be rejected before fetch");
  const controller = new AbortController(); controller.abort();
  const aborted: unknown = await client.request("/api/meta", { signal: controller.signal }).catch(error => error);
  check(aborted instanceof DOMException && aborted.name === "AbortError" && requests.length === before, "Already-aborted calls must not fetch");
  const canceledCatalog: unknown = await client.listApplications("project-1", { signal: controller.signal }).catch(error => error);
  check(canceledCatalog instanceof DOMException && canceledCatalog.name === "AbortError" && requests.length === before, "Catalog signal must survive the public method boundary");
  check(normalizeServerBaseUrl("https://consumer.invalid/base") === "https://consumer.invalid", "Profile normalizer must remain usable");
  return { requests, conflictRevision: 7, rejectedForeignOrigin: true, canceledBeforeTransport: true, canceledCatalogRead: true };
}

/** Same consumer code runs from the installed tarballs in Node and the browser bundle. */
export async function runConsumerChecks() {
  return { contracts: checkPureContracts(), scene: checkCompatibilityAndClock(), server: await checkServerTransport() };
}
