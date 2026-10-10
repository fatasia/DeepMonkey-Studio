# Unified external baselines and multi-cell decision audit

All entries below read frozen reports; no retraining, model selection, or test-label tuning was performed in this synthesis.

## Paired cell comparisons

| Source | Task | Model vs baseline | Metric | Cells | Model mean | Baseline mean | Baseline − model | 95% CI | Wilcoxon p |
|---|---|---|---|---:|---:|---:|---:|---|---:|
| HUST | native_voltage | adaptive_mixture vs trend | cell_macro_MAE_V | 77 | 0.0015205 | 0.00186839 | +0.000347896 | [+0.000335927, +0.00035964] | 2.463e-14 |
| HUST | native_voltage | adaptive_mixture vs persistence | cell_macro_MAE_V | 77 | 0.0015205 | 0.00521318 | +0.00369268 | [+0.00367157, +0.003714] | 2.463e-14 |
| HUST | native_voltage | adaptive_mixture vs uniform_weights | cell_macro_MAE_V | 77 | 0.0015205 | 0.00263109 | +0.00111059 | [+0.00109612, +0.00112514] | 2.463e-14 |
| HUST | native_voltage | adaptive_mixture vs validation_fixed_weights | cell_macro_MAE_V | 77 | 0.0015205 | 0.00255616 | +0.00103566 | [+0.00102221, +0.00104903] | 2.463e-14 |
| HUST | native_voltage | adaptive_mixture vs forced_physical_expert | cell_macro_MAE_V | 77 | 0.0015205 | 0.00764257 | +0.00612208 | [+0.00605204, +0.00619863] | 2.463e-14 |
| NA-ion | native_voltage | adaptive_mixture vs trend | cell_macro_MAE_V | 64 | 0.000735853 | 0.000395821 | -0.000340032 | [-0.000385522, -0.000293436] | 4.683e-12 |
| NA-ion | native_voltage | adaptive_mixture vs persistence | cell_macro_MAE_V | 64 | 0.000735853 | 0.00314442 | +0.00240857 | [+0.00217969, +0.00267702] | 3.525e-12 |
| NA-ion | native_voltage | adaptive_mixture vs trend | cell_macro_event_MAE_V | 64 | 0.0642119 | 0.0734241 | +0.00921221 | [+0.00638283, +0.012233] | 4.663e-08 |
| NA-ion | native_voltage | adaptive_mixture vs persistence | cell_macro_event_MAE_V | 64 | 0.0642119 | 0.106628 | +0.0424159 | [+0.0387027, +0.0459351] | 3.525e-12 |
| ZN-coin | native_voltage | adaptive_mixture vs trend | cell_macro_MAE_V | 140 | 0.00254776 | 0.00555679 | +0.00300902 | [+0.00244868, +0.00359088] | 5.361e-11 |
| ZN-coin | native_voltage | adaptive_mixture vs persistence | cell_macro_MAE_V | 140 | 0.00254776 | 0.00223891 | -0.000308855 | [-0.000561357, -8.85156e-05] | 0.8548 |
| ZN-coin | native_voltage | adaptive_mixture vs trend | cell_macro_event_MAE_V | 140 | 0.117429 | 0.130205 | +0.012776 | [+0.0117467, +0.0138402] | 1.011e-24 |
| ZN-coin | native_voltage | adaptive_mixture vs persistence | cell_macro_event_MAE_V | 140 | 0.117429 | 0.130037 | +0.0126078 | [+0.0115042, +0.0137449] | 1.011e-24 |
| HUST | soh_external | PINN vs standard | mape | 77 | 14.753 | 14.1657 | -0.5873 | [-1.00062, -0.201492] | 0.2716 |
| HUST | soh_external | PINN vs standard | rmse | 77 | 0.162743 | 0.166026 | +0.0032826 | [+0.000593389, +0.00575566] | 0.002145 |
| HUST | soh_external | PINN vs standard | mae | 77 | 0.149853 | 0.145863 | -0.00398971 | [-0.00770695, -0.000521219] | 0.8689 |
| HUST | soh_external | PINN vs standard | monotonic_violation_rate | 77 | 0.337601 | 0.364614 | +0.0270137 | [+0.0237394, +0.0302736] | 2.463e-14 |
| HUST | soh_external | PINN vs standard | monotonic_excess_rms | 77 | 0.0056081 | 0.00679345 | +0.00118535 | [+0.00110133, +0.00127018] | 2.463e-14 |
| HUST | soh_external | PINN vs standard | smoothness_rms | 77 | 0.0157692 | 0.0186372 | +0.00286799 | [+0.00266718, +0.00307034] | 2.463e-14 |

## Independent source summaries

| Source | Task | Units | Main result | Boundary |
|---|---|---:|---|---|
| Oxford Battery Degradation Dataset 1 | current-characterisation-cycle SOH from same-cycle C1 charge; target is independent C1 discharge capacity | 8 cells | cell-macro MAPE 2.708% | No Oxford training/calibration; not a measured internal-field reference |
| McMaster/Kollmeyer LG HG2 | leave-one-temperature-out laboratory reference | 6 temperature folds | mean gain 0.614 percentage points; 4/6 positive | one physical cell; cell-independent generalisation not proven |
| BAIC public vehicle replay | vehicle_soc_external | 20 vehicles | assimilation MAE 6.944 percentage points; 8/20 positive | BMS-referenced weak labels; all vehicles marked out-of-domain |

## Multi-cell decision validation

The final frozen confirmation contains 5 health-source cells and 12 paired numerical decision groups. The selected utility_1 policy has zero unsafe decisions. Comparisons average groups within each cell, then resample the five cells:

| Baseline | Selected − baseline cell-macro shortfall | 95% CI | Wilcoxon p |
|---|---:|---|---:|
| utility_0 | -0.0439957 | [-0.109244, +0] | 0.5 |
| boundary_1 | +0 | [+0, +0] | 1 |
| charge_1 | -0.0439957 | [-0.109244, +0] | 0.5 |
| SPMe_early_stop_6 | -0.0294481 | [-0.0721193, +0] | 0.5 |

The decision results are numerical controls with hidden health/diffusivity perturbations; they are not a physical safety certificate.
