# create-deepmonkey

Create a standalone DeepMonkey 3D application with eight templates and Codex / Claude Skills.

```sh
npx create-deepmonkey my-world
```

The command installs dependencies and starts the local WebGPU application. Node.js 24+ is required. Edit `scene.ts`; use `npm run dev` to restart and `npm run build` to export a static website.

Choose another template with `--template 06-logistics`. Use `--no-start` to install without starting, `--no-install` to generate files only, or `--no-open` to keep the browser closed.

## Templates

| Template | Scene |
| --- | --- |
| `01-starter` | Minimal application |
| `02-factory-floor` | Factory floor (default) |
| `03-equipment-monitor` | Equipment monitoring |
| `04-robot-cell` | Robot work cell |
| `05-pipeline` | Pipeline |
| `06-logistics` | Logistics |
| `07-energy` | Energy |
| `08-structure` | Structural model |

Each project includes TypeScript sources, the DeepMonkey SDK, a render loop, responsive canvas sizing and both AI Skills. The CLI refuses to overwrite a non-empty directory.

## Develop with AI

Open the generated project in Codex or Claude Code:

```text
Codex: $deep-engine-3d add equipment status indicators and a camera tour.
Claude Code: /deep-engine-3d add equipment status indicators and a camera tour.
```

Skills live in `.agents/skills/deep-engine-3d/` and `.claude/skills/deep-engine-3d/`. Browser rendering requires WebGPU on HTTPS or localhost.

Want the complete editor instead? Run `npx deepmonkey`. To add the SDK to an existing project, use `npm i deepmonkey`.

[SDK package](https://www.npmjs.com/package/deepmonkey) · [AI development guide](https://github.com/fatasia/DeepMonkey-Studio/blob/main/docs/ai-development.md) · [GitHub](https://github.com/fatasia/DeepMonkey-Studio) · [Issues](https://github.com/fatasia/DeepMonkey-Studio/issues)

See the included license files for project terms and third-party notices.
