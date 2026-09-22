import { DeepApp, DeepAppInitializationError, createDeepAppResource, type DeepAppPlugin } from "@bim-studio/deep-engine/app";

function check(value: unknown, message: string): void { if (!value) throw new Error(message); }

const value = createDeepAppResource<number>("external.value"), events: string[] = [];
const base: DeepAppPlugin<{ ticks: number }> = { id: "base", setup(context) {
  events.push("setup:base"); context.provide(value, 3); context.invalidate("initial");
  context.addFrameStage({ id: "update", execute: frame => { frame.context.state.ticks += frame.context.requireResource(value); } });
  context.onDispose(() => { events.push("dispose:base"); });
} };
const dependent: DeepAppPlugin<{ ticks: number }> = { id: "dependent", dependencies: ["base"], setup(context) {
  events.push(`setup:dependent:${context.requireResource(value)}`); return () => { events.push("dispose:dependent"); };
} };
const app = await DeepApp.create({ state: { ticks: 0 }, plugins: [dependent, base] });
check((await app.advance(0)).status === "rendered" && app.state.ticks === 3, "Initial host frame failed");
app.invalidate("external-update"); check((await app.advance(16)).status === "rendered" && app.state.ticks === 6, "Updated host frame failed");
const firstDispose = app.dispose(), secondDispose = app.dispose(); check(firstDispose === secondDispose, "Dispose promise was not reused"); await firstDispose;
check(events.join("|") === "setup:base|setup:dependent:3|dispose:dependent|dispose:base", "Plugin order mismatch");

const rollback: string[] = [];
const failed = await DeepApp.create({ state: null, plugins: [{ id: "prepared", setup(context) {
  context.onDispose(() => { rollback.push("prepared"); });
} }, { id: "broken", dependencies: ["prepared"], setup(context) {
  context.onDispose(() => { rollback.push("broken"); }); throw new Error("external failure fixture");
} }] }).catch(error => error);
check(failed instanceof DeepAppInitializationError, "Setup failure did not use DeepAppInitializationError");
check(rollback.join("|") === "broken|prepared", "Failed setup did not roll back in reverse order");
const recovered = await DeepApp.create({ state: "recovered", plugins: [] }); await recovered.dispose();

console.log(JSON.stringify({ ticks: app.state.ticks, order: events, rollback,
  failedPlugin: failed.trace.find((entry: { status: string }) => entry.status === "failed")?.stage,
  duplicateDispose: firstDispose === secondDispose, recovered: recovered.status }));
