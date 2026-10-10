# TwinMoE reproduction entry

The repository contains the PINN/PINO training entry points, model contracts, the current paper source package and the frozen audit summary. The complete author-review package records the source hashes, generated controls and third-party data lineage.

## Quick source check

From `research/battery-twin`:

```sh
python -m pip install -r requirements.txt
python -m unittest discover -s tests -p 'test_*.py'
python pretrain_battery_spm_pinn_head.py --scenarios 16 --epochs 1 --batch-size 8 --output checkpoints/research-candidate/smoke-pinn
python train_spm_pino_transformer_candidate.py --scenarios 32 --time-steps 8 --radial-points 8 --model-dim 16 --operator-width 8 --operator-layers 1 --radial-modes 4 --stage1-epochs 1 --stage2-epochs 1 --router-epochs 1 --batch-size 8 --output checkpoints/research-candidate/smoke-pino.pt
```

The small runs check the training contracts and checkpoint writing. They do not regenerate the paper's frozen measurements.

## Frozen review

The author-review run used the source project in `D:/Documents/New project 3/battery-model-service` with separate Python 3.13 and Python 3.12 environments. Its execution order is recorded in the local review package. The final confirmation includes 64 independently drawn numerical field controls, 48 continuous-duration controls, split-conformal state coverage, eight cross-solver checks, 20 vehicle-isolated BAIC traces, and a five-cell, twelve-group numerical decision audit.

The public evidence summary keeps voltage, SOH, SOC and decision tasks separate. It uses cell-level bootstrap intervals and paired Wilcoxon tests; decision groups are averaged within each health-source cell before resampling. Numerical decision controls are not physical safety certificates.

## Data and licenses

Measured sources and third-party weights retain their original licenses. The repository publishes code, paper sources, vector figures and summary statistics; private caches, credentials, raw local datasets and checkpoints are excluded.
