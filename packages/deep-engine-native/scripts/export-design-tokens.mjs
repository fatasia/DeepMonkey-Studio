// U07: exports a versioned design-token snapshot from the single source of
// truth (apps/web/src/styles/base.css) for native consumption. Native never
// reads CSS or CSSOM — it consumes this JSON snapshot, validated by
// src/native_ui/design_tokens.rs.
//
// Usage: node scripts/export-design-tokens.mjs [repo-root]
// Writes fixtures/design-tokens-v1.json next to this package's Cargo.toml.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? join(here, "../../..");
const css = readFileSync(join(root, "apps/web/src/styles/base.css"), "utf8");

/** Parses `#rgb #rrggbb rgba(...) rgb(...)` into [r,g,b] 0..255. */
function parseColor(value) {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgbSpace = value.match(/^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (rgbSpace) return [Number(rgbSpace[1]), Number(rgbSpace[2]), Number(rgbSpace[3])];
  const rgbComma = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (rgbComma) return [Number(rgbComma[1]), Number(rgbComma[2]), Number(rgbComma[3])];
  return null;
}

/** Resolves `color-mix(in srgb, <color> <p>%, <color>)` with hex/keyword ends. */
function resolveColorMix(value, vars) {
  const mix = value.match(/^color-mix\(in srgb,\s*([^,]+?)\s+([\d.]+)%,\s*([^)]+)\)$/i);
  if (!mix) return null;
  const resolve = (token) => {
    const trimmed = token.trim();
    if (trimmed.startsWith("var(")) {
      const inner = resolveVar(trimmed, vars);
      return inner ? parseColor(inner) : null;
    }
    const named = { white: [255, 255, 255], black: [0, 0, 0] };
    return parseColor(trimmed) ?? named[trimmed.toLowerCase()] ?? null;
  };
  const left = resolve(mix[1]);
  const weight = Number(mix[2]) / 100;
  if (!left) return null;
  // CSS color-mix with `transparent` keeps the color and multiplies alpha.
  if (mix[3].trim().toLowerCase() === "transparent") {
    return { channels: left, alpha: weight };
  }
  const right = resolve(mix[3]);
  if (!right) return null;
  // Returning the mixed result directly keeps normalization in one place.
  return {
    channels: left.map((channel, index) => channel * weight + right[index] * (1 - weight)),
    alpha: 1,
  };
}

function resolveVar(expression, vars) {
  const name = expression.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (!name) return null;
  const value = vars.get(name[1]);
  if (value === undefined) return null;
  if (value.startsWith("var(")) return resolveVar(value, vars);
  return value;
}

/** Extracts `--name: value;` pairs from one CSS block body. */
function collectVars(body, into) {
  for (const match of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    into.set(`--${match[1]}`, match[2].trim());
  }
}

const darkBlock = css.match(/^:root \{([\s\S]*?)^\}/m);
const lightBlock = css.match(/^:root\[data-theme="light"\] \{([\s\S]*?)^\}/m);
if (!darkBlock || !lightBlock) {
  console.error("base.css must contain a :root block and a :root[data-theme=light] block");
  process.exit(1);
}

function themeSnapshot(baseVars, overrideBlock) {
  const vars = new Map(baseVars);
  const overrides = new Map();
  collectVars(overrideBlock[1], overrides);
  for (const [key, value] of overrides) vars.set(key, value);

  const color = (name) => {
    const raw = vars.get(name);
    if (raw === undefined) return null;
    const mixed = resolveColorMix(raw, vars);
    if (mixed) {
      return [
        ...mixed.channels.map((c) => +(c / 255).toFixed(4)),
        mixed.alpha,
      ];
    }
    let value = raw;
    if (value.startsWith("var(")) value = resolveVar(value, vars) ?? value;
    const channels = parseColor(value);
    if (!channels) return null;
    // Alpha: the fourth rgba() channel when present, else opaque.
    const alphaMatch = raw.match(/rgba?\([^)]*?,\s*([\d.]+)\s*\)/);
    const alpha = alphaMatch ? Number(alphaMatch[1]) : 1;
    return [...channels.map((c) => +(c / 255).toFixed(4)), alpha];
  };

  return {
    colors: Object.fromEntries(
      [
        "bg-0", "bg-1", "surface-1", "surface-2", "surface-3",
        "line-subtle", "line", "line-strong",
        "text-strong", "text", "text-muted", "text-faint",
        "accent", "accent-hover", "accent-soft",
        "success", "warning", "danger", "info",
      ].map((name) => [name, color(`--${name}`)]),
    ),
    radii: Object.fromEntries(
      ["radius-xs", "radius-sm", "radius-md", "radius-lg"].map((name) => [
        name,
        Number.parseFloat(vars.get(`--${name}`) ?? "0") || 0,
      ]),
    ),
    spacing: Object.fromEntries(
      ["space-1", "space-2", "space-3", "space-4", "space-6"].map((name) => [
        name,
        Number.parseFloat(vars.get(`--${name}`) ?? "0") || 0,
      ]),
    ),
    typography: {
      fontFamily: "Inter, ui-sans-serif, system-ui, 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif",
      fontSizeBase: Number.parseFloat(vars.get("--root-font-size") ?? "13"),
      lineHeight: 1.45,
    },
    motion: {
      // Duration/easing ladder used by the shell; reduced-motion collapses
      // every duration to 0 (verified by the native contract test).
      fastMs: 150,
      baseMs: 200,
      slowMs: 320,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    },
    reducedMotion: {
      fastMs: 0,
      baseMs: 0,
      slowMs: 0,
      easing: "linear",
    },
  };
}

const darkVars = new Map();
collectVars(darkBlock[1], darkVars);
// Root-level colors declared outside the var list (color/background lines).
darkVars.set("--text-strong", "#e6ecef");
darkVars.set("--bg-0", "#0b1114");
darkVars.set("--accent", "#d6aa4d");

const lightVars = new Map(darkVars);
const snapshot = {
  schemaVersion: 1,
  id: "deep.design-tokens.v1",
  source: "apps/web/src/styles/base.css",
  brandOverrideKey: "--accent",
  themes: {
    dark: themeSnapshot(darkVars, { 1: "" }),
    light: themeSnapshot(lightVars, lightBlock),
  },
};
// The dark theme is the :root block itself (no overrides beyond base).
snapshot.themes.dark = themeSnapshot(darkVars, { 1: darkBlock[1] });

const outPath = join(here, "../fixtures/design-tokens-v1.json");
writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`design tokens exported: ${outPath}`);
