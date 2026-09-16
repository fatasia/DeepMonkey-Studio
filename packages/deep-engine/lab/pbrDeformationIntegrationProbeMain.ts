import { runPbrDeformationIntegrationProbe, type IntegrationVariant } from "./pbrDeformationIntegrationProbe.js";
const output = document.querySelector("pre")!;
const gallery = document.createElement("div"); document.body.prepend(gallery);
const variant: IntegrationVariant = new URLSearchParams(location.search).get("variant") === "materials-effects" ? "materials-effects" : "baseline";
const results: unknown[] = [];
try {
  for (const kind of ["skin", "morph", "morph-skin"] as const) {
    output.textContent = `${kind}: running production renderer…\n${JSON.stringify(results, null, 2)}`;
    const canvas = document.createElement("canvas"); canvas.width = 128; canvas.height = 128; document.body.append(canvas);
    results.push(await runPbrDeformationIntegrationProbe(canvas, kind, variant, (name, source) => {
      const figure = document.createElement("figure"), label = document.createElement("figcaption"), preview = document.createElement("canvas");
      label.textContent = `${kind} / ${variant} / ${name}`; preview.width = source.width; preview.height = source.height;
      preview.getContext("2d")!.drawImage(source, 0, 0); figure.style.display = "inline-block";
      figure.append(preview, label); gallery.append(figure);
    }));
    canvas.remove();
  }
  output.textContent = JSON.stringify(results, null, 2);
  document.title = results.every(value => (value as { passed: boolean }).passed) ? "PBR Integration PASS" : "PBR Integration FAIL";
} catch (error) { output.textContent = `${String(error)}\n${JSON.stringify(results, null, 2)}`; document.title = "PBR Integration ERROR"; }
