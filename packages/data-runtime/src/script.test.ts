import { describe, expect, it } from "vitest";
import { executeDataScript, executeRowScript, ScriptRuntimeError } from "./script.js";

describe("isolated data scripts", () => {
  it("transforms JSON input and emits normalized data events", async () => {
    const result = await executeDataScript<{ fahrenheit: number }>(`
      const fahrenheit = Math.round((input.temperature * 1.8 + 32) * 10) / 10;
      emit("temperature.fahrenheit", fahrenheit, { source: "script/temperature" });
      log("converted", input.deviceId);
      return { fahrenheit };
    `, { deviceId: "AHU-01", temperature: 26.4 });

    expect(result.output).toEqual({ fahrenheit: 79.5 });
    expect(result.emissions).toEqual([{ key: "temperature.fahrenheit", value: 79.5, source: "script/temperature" }]);
    expect(result.logs).toEqual(["converted AHU-01"]);
  });

  it("does not expose Node, network, DOM, or timer globals", async () => {
    const result = await executeDataScript(`return [typeof process, typeof require, typeof fetch, typeof window, typeof setTimeout];`, {});
    expect(result.output).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined"]);
  });

  it("runs a row function once per record in one sandbox", async () => {
    const result = await executeRowScript<number>("return input.temperature + vars.offset + vars.index;", [{ temperature: 20 }, { temperature: 25 }], { variables: { offset: 2 } });
    expect(result.output).toEqual([22, 28]);
  });

  it("interrupts infinite loops at the configured deadline", async () => {
    await expect(executeDataScript("while (true) {}", {}, {}, { timeoutMs: 10 })).rejects.toMatchObject<Partial<ScriptRuntimeError>>({ code: "TIMEOUT" });
  });
});
