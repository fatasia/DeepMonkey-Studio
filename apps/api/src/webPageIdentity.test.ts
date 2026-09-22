import { describe, expect, it } from "vitest";
import { isStudioWebPage } from "./webPageIdentity.js";

describe("Studio Web page identity", () => {
  it.each(["DeepMonkey Studio", "Deep Monkey Studio", " DeepMonkey Studio "])("recognizes %s", title => {
    expect(isStudioWebPage(`<html><title>${title}</title><div id="root">Loading</div></html>`)).toBe(true);
  });
  it.each([
    '<title>DeepMonkey Studio</title><div id="error">Unavailable</div>',
    '<title>Other App</title><div id="root"></div>',
    '<title>DeepMonkey Studio error</title><div id="root"></div>',
    '<title>DeepMonkey Studio</title><div data-id="root"></div>',
  ])("rejects unrelated or incomplete shells", html => expect(isStudioWebPage(html)).toBe(false));
});
