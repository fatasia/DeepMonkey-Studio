# Battery twin research

PINN physics-head training and PINO expert training for battery digital twins, with generated SPM scenarios and focused tests.

- Train the single-particle physics head with diffusion, conservation and voltage constraints.
- Train the temporal spectral operator in data-only, physics-informed and router-calibration stages.
- Inspect the lightweight/operator mixture, physical-risk routing and optional multiphysics modules.
- Trace the exported source snapshot through `source-manifest.json`.

## Run

Use a separate Python environment. From this directory:

```sh
python -m pip install -r requirements.txt
python -m unittest discover -s tests -p 'test_*.py'
python pretrain_battery_spm_pinn_head.py --scenarios 16 --epochs 1 --batch-size 8 --output checkpoints/research-candidate/smoke-pinn
python train_spm_pino_transformer_candidate.py --scenarios 32 --time-steps 8 --radial-points 8 --model-dim 16 --operator-width 8 --operator-layers 1 --radial-modes 4 --stage1-epochs 1 --stage2-epochs 1 --router-epochs 1 --batch-size 8 --output checkpoints/research-candidate/smoke-pino.pt
```

These small runs verify that training and checkpoint writing work. They do not reproduce the paper's reported accuracy. Use `--help` for full training options and `--dataset` for PINO NPZ input; the loader validates its tensor contract. Generated examples require no downloaded battery dataset. Checkpoints, local data and caches are excluded from Git.

## Models and platform

| Component | Source |
| --- | --- |
| PINN head and gradient-conflict attenuation | [research/battery_spm_pinn.py](research/battery_spm_pinn.py) |
| PINO and lightweight/operator experts | [models/spm_pino_transformer.py](models/spm_pino_transformer.py) |
| Physical residuals and generated scenarios | [research/spm_physics.py](research/spm_physics.py), [research/spm_dataset.py](research/spm_dataset.py) |
| Platform expert adoption | [batteryExpertRouting.ts](../../apps/api/src/batteryExpertRouting.ts) |
| Native inference | [battery-native-runtime](../../apps/battery-native-runtime/) |

`train_batterymformer_pinn.py` is the integration launcher for the separately maintained [BatteryMFormer backbone](https://github.com/Ruifeng-Tan/BatteryMFormer). That full fine-tuning route requires its adapted `run_main.py`, data preparation, split files and warm-start weights; those are not bundled here. The standalone PINN-head and PINO commands above are self-contained. The optional backbone integration test is skipped when the upstream implementation is absent. BatteryMFormer is upstream work; this directory contains our physical extensions and operator research snapshot. Its full launcher is supplied for inspection, not advertised as a one-command reproduction of the archived HUST results.

## Paper and evidence

[Paper reading copies and source packages](../../docs/research/papers/README.md). The current TwinMoE manuscript is awaiting `cs.LG` endorsement on arXiv. The repository includes the current PDF, TeX source package and frozen external-audit summary. Source publication and smoke training do not replace the archived checkpoint configurations or data splits. In particular, evaluate sparse routing with a common counterfactual reference; legacy route-dependent oracle scores are not comparative evidence.

Verification on 2026-10-10: 31 focused field/state/decision tests passed. The frozen author-review package reports 64 final field controls, 48 continuous controls, 20 external vehicle traces and 5 health-source cells in the decision audit. Smoke commands remain the quick source check; full paper experiments were not rerun for this source export.

## Frozen evidence

- [`evidence/unified-external-baselines-20261010.md`](evidence/unified-external-baselines-20261010.md) — paired cell-level voltage and SOH comparisons, Oxford/McMaster/BAIC source summaries, and the five-cell decision audit.
- [`evidence/unified-external-baselines-20261010.json`](evidence/unified-external-baselines-20261010.json) — machine-readable values and bootstrap intervals.
- [`evidence/REPRODUCE-TWINMOE.md`](evidence/REPRODUCE-TWINMOE.md) — frozen execution order and data lineage.

The repository [license](../../LICENSE) applies to this source. Upstream code, datasets and model weights retain their own terms.
