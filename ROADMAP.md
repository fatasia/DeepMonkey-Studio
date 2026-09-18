# Roadmap

Deep Monkey Studio is developing a self-hosted path from industrial models and data to published visual applications. Priorities below describe direction; release notes identify what has shipped.

## Current priorities

| Area | Next outcome | Acceptance evidence |
| --- | --- | --- |
| First-use experience | Reproducible setup, useful offline docs and clear errors | Clean checkout, first saved scene and publication walkthrough |
| Scene delivery | Repeatable versioned packages and recoverable failures | Frozen dependencies, integrity checks and restore tests |
| Deep Engine | Extend WebGPU and Native within an explicit capability matrix | Per-feature tests, real GPU runs and equivalent rendering comparisons |
| Data and integrations | Diagnose failed connections and preserve runtime contracts | Connection → dataset → pipeline → binding checks |
| Public repository | Reviewable contributions and traceable releases | Governance, attribution, release checks and host protection settings |

Three.js WebGL remains the authoring baseline. Deep WebGPU is integrated as an alternative backend; Native is a separate delivery target with its own validation. A development milestone is not a claim that every scene or component is ready for Native delivery.

## Scope

The project focuses on BIM/CAD visualization, dashboards, data connections, controlled scripting and selected industrial planning workflows. It does not currently target a full PLM suite, a complete robot offline-programming system, arbitrary Three.js plugin compatibility or feature parity with general-purpose game engines.

Experimental work needs explicit inputs, unsupported cases and reproducible results before entering a release. Performance comparisons must hold assets, device, camera path, resolution and quality settings constant.

## Propose a change

Open a feature proposal with the user problem, current workaround, expected result and maintenance cost. Maintainers may request a design note before scheduling work. An accepted proposal has no delivery date until a release milestone explicitly states one.

Read [CHANGELOG.md](CHANGELOG.md) for implemented changes, [capabilities](docs/capabilities.md) for feature details and [the Deep Engine plan](docs/specs/deep-engine-execution-plan-2026-09-15.md) for engineering work in progress.
