import { expect, it } from "vitest";
import { parseUniqueRuntimeJson } from "./jsonInput.js";

it("skips long unescaped byte strings while still rejecting later duplicate object keys",()=>{
  const text = "A".repeat(4*1024*1024);
  expect(parseUniqueRuntimeJson(JSON.stringify({payload:text,nested:{id:1}}))).toEqual({payload:text,nested:{id:1}});
  expect(()=>parseUniqueRuntimeJson(`{"payload":"${text}","nested":{"id":1,"id":2}}`)).toThrow("Duplicate JSON field");
});
it("keeps escape, malformed string and nesting checks on the strict path",()=>{
  const text = "A".repeat(100_000)+"\\\"end";
  expect(parseUniqueRuntimeJson(JSON.stringify({value:text}))).toEqual({value:text});
  expect(()=>parseUniqueRuntimeJson('{"bad":"unterminated')).toThrow();
  expect(()=>parseUniqueRuntimeJson('{"escaped\\u0049d":1,"escapedId":2}')).toThrow("Duplicate JSON field");
  expect(()=>parseUniqueRuntimeJson('['.repeat(35)+'0'+']'.repeat(35))).toThrow("depth");
});
