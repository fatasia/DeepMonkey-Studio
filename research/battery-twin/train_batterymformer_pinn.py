"""Isolated PINN pilot launcher for BatteryMFormer (SOH physics prior).

Safety contract (per user instruction 2026-07-24):
  - Trains an ISOLATED candidate only. Default --output is
    checkpoints/batterymformer-pinn-candidate, never the production directory
    checkpoints/batterymformer-expanded. Uses its own cache_root.
  - Reuses the SAME expanded split json as production (default
    cache/batterymformer-expanded-split.json) so the candidate's test cells are
    identical to production v2b's and the comparison is fair.
  - Passes the physics flags added to run_main.py (--lambda_physics etc.), which
    are no-ops in production because the production launcher never passes them.
  - Enables gradient clipping (the run_main.py clip was previously commented out)
    because this exact model NaN'd on the earlier v2c experiment.
  - Does NOT publish. finalize_batterymformer.py is run separately by the user
    against the candidate; it already refuses to overwrite an existing production
    dir, so promotion can never happen implicitly.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


def main() -> None:
    service_root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, default=service_root / "data" / "batterylife-v11-mini")
    parser.add_argument("--split", type=Path, default=service_root / "cache" / "batterymformer-expanded-split.json")
    parser.add_argument("--output", type=Path, default=service_root / "checkpoints" / "batterymformer-pinn-candidate")
    parser.add_argument("--cache-root", type=Path)
    parser.add_argument("--split-tag", type=str)
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--learning-rate", type=str, default="0.00012")
    parser.add_argument(
        "--warm-start",
        type=Path,
        default=service_root / "checkpoints" / "batterymformer-expanded" / "model.safetensors",
    )
    parser.add_argument("--physics-head-warm-start", type=Path)
    parser.add_argument("--no-amp", action="store_true",
                        help="Disable mixed precision (fp32) — stabilizes the Farasis epoch-1 NaN")
    parser.add_argument("--skip-nonfinite-loss", action="store_true",
                        help="Skip NaN/Inf batches (fp16 stability path)")
    # Physics controls
    parser.add_argument("--lambda-physics", type=float, default=0.05)
    parser.add_argument("--physics-smooth-weight", type=float, default=0.25)
    parser.add_argument("--physics-boundary-weight", type=float, default=1.0)
    parser.add_argument("--physics-survival-weight", type=float, default=2.0)
    parser.add_argument("--physics-trend-weight", type=float, default=0.50)
    parser.add_argument("--physics-collapse-rate-weight", type=float, default=0.25)
    parser.add_argument("--physics-trend-window", type=int, default=5)
    parser.add_argument("--physics-collapse-rate-multiplier", type=float, default=4.0)
    parser.add_argument("--physics-collapse-rate-floor", type=float, default=0.002)
    parser.add_argument("--physics-mono-tol", type=float, default=0.002)
    parser.add_argument("--physics-warmup-epochs", type=int, default=8)
    parser.add_argument("--physics-max-data-loss-ratio", type=float, default=0.10)
    parser.add_argument("--lambda-spm-pinn", type=float, default=0.20)
    parser.add_argument("--spm-pinn-warmup-epochs", type=int, default=3)
    parser.add_argument("--spm-pinn-max-data-loss-ratio", type=float, default=0.35)
    parser.add_argument("--spm-radial-points", type=int, default=10)
    parser.add_argument("--spm-collocation-steps", type=int, default=48)
    parser.add_argument("--spm-hidden-dim", type=int, default=64)
    parser.add_argument(
        "--spm-condition-ablation",
        choices=("none", "chemistry", "all"),
        default="none",
    )
    parser.add_argument("--physics-head-learning-rate", type=str, default="0.0001")
    parser.add_argument("--spm-ocv-anchor-weight", type=float, default=0.50)
    parser.add_argument("--spm-parameter-prior-weight", type=float, default=0.25)
    parser.add_argument("--spm-physical-observation-weight", type=float, default=1.0)
    parser.add_argument("--spm-pde-weight", type=float, default=1.0)
    parser.add_argument("--spm-boundary-weight", type=float, default=1.0)
    parser.add_argument("--spm-conservation-weight", type=float, default=1.0)
    parser.add_argument("--spm-soc-weight", type=float, default=2.0)
    parser.add_argument("--gradient-conflict-weighting", action="store_true")
    parser.add_argument("--gradient-conflict-floor", type=float, default=0.15)
    parser.add_argument("--gradient-conflict-ema", type=float, default=0.90)
    parser.add_argument("--gradient-conflict-interval", type=int, default=20)
    parser.add_argument("--tail-loss-weight", type=float, default=0.50)
    parser.add_argument("--tail-loss-fraction", type=float, default=0.20)
    parser.add_argument("--rul-threshold-weight", type=float, default=0.05)
    parser.add_argument("--rul-threshold-temperature", type=float, default=0.05)
    parser.add_argument("--rul-threshold-bandwidth", type=float, default=0.20)
    parser.add_argument("--freeze-backbone", action="store_true")
    parser.add_argument("--physics-field-calibration", action="store_true")
    parser.add_argument("--freeze-identified-parameters", action="store_true")
    parser.add_argument("--grad-clip", type=float, default=1.0)
    args = parser.parse_args()

    if args.output.name == "batterymformer-expanded":
        raise SystemExit("拒绝把 PINN 候选写入生产目录名 batterymformer-expanded。")

    if not args.resume:
        (args.output / "training_resume.pt").unlink(missing_ok=True)
    source = service_root / "vendor" / "BatteryMFormer"
    prompt = source / "data_provider" / "prompt_embeddings" / "Qwen3_total.pkl"
    command = [
        sys.executable, "run_main.py",
        "--model", "BatteryMFormer", "--dataset", "Li_ion",
        "--root_path", str(args.data_root.resolve()),
        "--processed_SOH_path", str((args.data_root / "processed_SOH").resolve()),
        "--checkpoints", str(args.output.resolve()),
        "--input_mode", "current_voltage", "--split_json_path", str(args.split.resolve()),
        "--split_tag", (args.split_tag or f"pinn_2026_{args.output.name}"), "--prompt_embeddings_path", str(prompt.resolve()),
        "--batch_size", "8", "--train_epochs", str(args.epochs), "--learning_rate", str(args.learning_rate),
        "--lradj", "constant", "--warmup_epochs", "5", "--weight_decay", "0",
        "--patience", "12", "--d_model", "128", "--n_heads", "8", "--e_layers", "2",
        "--e_layers2", "2", "--d_layers", "4", "--d_ff", "128", "--d_ffs", "128",
        "--dropout", "0.2", "--activation", "gelu", "--factor", "1", "--seq_len", "1",
        "--pred_len", "5000", "--eol_threshold", "0.8", "--truncate_start_cycle", "100",
        "--early_cycle_threshold", "100", "--charge_discharge_length", "300",
        "--task_name", "soh_forecast", "--d_llm", "1024", "--cache_root", str((args.cache_root or (service_root / "cache" / args.output.name)).resolve()),
        "--gpu", "0", "--seed", str(args.seed), "--num_query", "8", "--accumulation_steps", "2",
        "--lambda_recovery", "100", "--num_slots", "64", "--temperature", "1", "--top_k", "2",
        "--lambda_mem", "10", "--lambda_life_loss", "0", "--num_segments", "50",
        "--tail_loss_weight", str(args.tail_loss_weight),
        "--tail_loss_fraction", str(args.tail_loss_fraction),
        "--censor_aware_rul",
        "--rul_threshold_weight", str(args.rul_threshold_weight),
        "--rul_threshold_temperature", str(args.rul_threshold_temperature),
        "--rul_threshold_bandwidth", str(args.rul_threshold_bandwidth),
        "--k_dim", "512", "--enc_in", "3", "--kernel_size", "10", "--cnn_channels", "16",
        "--use_capacity_resample", "--num_workers", "0",
        # --- PINN additions (no-ops in production, active here) ---
        "--lambda_physics", str(args.lambda_physics),
        "--physics_smooth_weight", str(args.physics_smooth_weight),
        "--physics_boundary_weight", str(args.physics_boundary_weight),
        "--physics_survival_weight", str(args.physics_survival_weight),
        "--physics_trend_weight", str(args.physics_trend_weight),
        "--physics_collapse_rate_weight", str(args.physics_collapse_rate_weight),
        "--physics_trend_window", str(args.physics_trend_window),
        "--physics_collapse_rate_multiplier", str(args.physics_collapse_rate_multiplier),
        "--physics_collapse_rate_floor", str(args.physics_collapse_rate_floor),
        "--physics_mono_tol", str(args.physics_mono_tol),
        "--physics_warmup_epochs", str(args.physics_warmup_epochs),
        "--physics_max_data_loss_ratio", str(args.physics_max_data_loss_ratio),
        "--lambda_spm_pinn", str(args.lambda_spm_pinn),
        "--spm_pinn_warmup_epochs", str(args.spm_pinn_warmup_epochs),
        "--spm_pinn_max_data_loss_ratio", str(args.spm_pinn_max_data_loss_ratio),
        "--spm_radial_points", str(args.spm_radial_points),
        "--spm_collocation_steps", str(args.spm_collocation_steps),
        "--spm_hidden_dim", str(args.spm_hidden_dim),
        "--spm_condition_ablation", args.spm_condition_ablation,
        "--physics_head_learning_rate", str(args.physics_head_learning_rate),
        "--spm_ocv_anchor_weight", str(args.spm_ocv_anchor_weight),
        "--spm_parameter_prior_weight", str(args.spm_parameter_prior_weight),
        "--spm_physical_observation_weight", str(args.spm_physical_observation_weight),
        "--spm_pde_weight", str(args.spm_pde_weight),
        "--spm_boundary_weight", str(args.spm_boundary_weight),
        "--spm_conservation_weight", str(args.spm_conservation_weight),
        "--spm_soc_weight", str(args.spm_soc_weight),
        "--spm_gradient_conflict_floor", str(args.gradient_conflict_floor),
        "--spm_gradient_conflict_ema", str(args.gradient_conflict_ema),
        "--spm_gradient_conflict_interval", str(args.gradient_conflict_interval),
        "--use_grad_clip", "--grad_clip", str(args.grad_clip),
    ]
    if args.lambda_spm_pinn > 0:
        command.append("--enable_spm_pinn")
    if args.gradient_conflict_weighting:
        command.append("--spm_gradient_conflict_weighting")
    if args.warm_start:
        command.extend(["--warm_start_checkpoint", str(args.warm_start.resolve())])
    if args.physics_head_warm_start:
        command.extend(
            [
                "--physics_head_warm_start_checkpoint",
                str(args.physics_head_warm_start.resolve()),
            ]
        )
    if args.freeze_backbone:
        command.append("--freeze_backbone")
    if args.physics_field_calibration:
        command.append("--physics_field_calibration")
    if args.freeze_identified_parameters:
        command.append("--freeze_identified_parameters")
    if not args.no_amp:
        command.append("--use_amp")
    if args.skip_nonfinite_loss:
        command.append("--skip_nonfinite_loss")
    if args.resume:
        command.append("--resume_existing")
    environment = dict(os.environ)
    environment.setdefault("WANDB_MODE", "disabled")
    environment.setdefault("PYTHONUTF8", "1")
    environment.setdefault("PYTHONIOENCODING", "utf-8")
    existing_pythonpath = environment.get("PYTHONPATH", "")
    environment["PYTHONPATH"] = os.pathsep.join(
        item for item in (str(service_root), existing_pythonpath) if item
    )
    print("PINN candidate ->", args.output, flush=True)
    subprocess.run(command, cwd=source, env=environment, check=True)


if __name__ == "__main__":
    main()
