import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { DIFF_HIGHLIGHT_TOKENS, ModelDiffOverlay, resolveDiffHighlightColors } from "./modelDiffOverlay";

function mesh(name: string, material: THREE.Material | THREE.Material[]): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(), material);
}

const colors = resolveDiffHighlightColors((token) => (token === "--success" ? "#59c58d" : token === "--danger" ? "#e27478" : token === "--warning" ? "#d8ac52" : ""));

describe("diff highlight token mapping (P1 slice)", () => {
  it("derives the three colors from design tokens without hardcoding semantic values", () => {
    expect(DIFF_HIGHLIGHT_TOKENS).toEqual({ added: "--success", removed: "--danger", modified: "--warning" });
    expect(colors.added.getHexString()).toBe("59c58d");
    expect(colors.removed.getHexString()).toBe("e27478");
    expect(colors.modified.getHexString()).toBe("d8ac52");
  });

  it("falls back to a neutral gray when a token is missing instead of inventing a semantic color", () => {
    const fallback = resolveDiffHighlightColors(() => "");
    expect(fallback.added.getHexString()).toBe("7f8c99");
    expect(fallback.removed.getHexString()).toBe("7f8c99");
    expect(fallback.modified.getHexString()).toBe("7f8c99");
  });
});

describe("ModelDiffOverlay", () => {
  it("overrides mesh materials with per-kind overlay materials and restores the originals on clear", () => {
    const shared = new THREE.MeshStandardMaterial();
    const plain = mesh("wall", new THREE.MeshStandardMaterial());
    const arrayed = mesh("window", [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()]);
    const sharedMesh = mesh("child-of-shared", shared);
    const root = new THREE.Group();
    root.add(plain, arrayed, sharedMesh);

    const overlay = new ModelDiffOverlay();
    overlay.apply([
      { object: plain, kind: "added" },
      { object: arrayed, kind: "removed" },
      { object: root, kind: "modified" },
    ], colors);

    expect(overlay.activeCount).toBe(3);
    expect(plain.material).not.toBe(shared);
    expect((plain.material as THREE.MeshStandardMaterial).emissive.getHexString()).toBe("59c58d");
    expect((plain.material as THREE.MeshStandardMaterial).transparent).toBe(true);
    expect(Array.isArray(arrayed.material)).toBe(false);
    expect((arrayed.material as THREE.MeshStandardMaterial).emissive.getHexString()).toBe("e27478");
    expect((sharedMesh.material as THREE.MeshStandardMaterial).emissive.getHexString()).toBe("d8ac52");

    overlay.clear();
    expect(overlay.activeCount).toBe(0);
    expect(Array.isArray(arrayed.material)).toBe(true);
    expect((plain.material as THREE.MeshStandardMaterial).emissive.getHexString()).not.toBe("59c58d");
    expect(sharedMesh.material).toBe(shared);
  });

  it("keeps one shared overlay material per kind so large diffs do not allocate per mesh", () => {
    const objects = Array.from({ length: 4 }, () => mesh("part", new THREE.MeshStandardMaterial()));
    const overlay = new ModelDiffOverlay();
    overlay.apply(objects.map((object) => ({ object, kind: "modified" as const })), colors);
    const applied = new Set(objects.map((object) => object.material));
    expect(applied.size).toBe(1);
    overlay.clear();
  });

  it("is idempotent: applying twice never stacks overlay materials", () => {
    const target = mesh("wall", new THREE.MeshStandardMaterial());
    const overlay = new ModelDiffOverlay();
    overlay.apply([{ object: target, kind: "added" }], colors);
    const firstOverlay = target.material;
    overlay.apply([{ object: target, kind: "removed" }], colors);
    expect(target.material).not.toBe(firstOverlay);
    overlay.clear();
    expect((target.material as THREE.MeshStandardMaterial).emissive.getHexString()).not.toBe("e27478");
    expect((target.material as THREE.MeshStandardMaterial).emissive.getHexString()).not.toBe("59c58d");
  });

  it("ignores non-mesh nodes and empty targets", () => {
    const group = new THREE.Group();
    const line = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    group.add(line);
    const overlay = new ModelDiffOverlay();
    overlay.apply([{ object: group, kind: "added" }], colors);
    expect(overlay.activeCount).toBe(0);
    expect(line.material).toBeInstanceOf(THREE.LineBasicMaterial);
    overlay.clear();
  });
});
