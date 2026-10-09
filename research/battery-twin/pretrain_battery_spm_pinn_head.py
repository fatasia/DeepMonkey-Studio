"""Lightweight physics pretraining for the isolated BatteryMFormer SPM-PINN head.

The synthetic scenarios have known dimensionless concentration fields,
diffusivities, surface flux scales and voltage equations.  This stage anchors
parameter semantics before real-data fine-tuning; it does not create synthetic
lifetime labels and never writes a production BatteryMFormer checkpoint.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import torch
import torch.nn.functional as F
from safetensors.torch import save_file

from research.battery_spm_pinn import BatterySPMPINNHead
from research.spm_dataset import generate_dimensionless_spm_dataset


def _condition_tensor(dataset, nominal_capacity_ah: torch.Tensor) -> torch.Tensor:
    count = dataset.current_c_rate.shape[0]
    condition = torch.zeros(count, 11)
    condition[
        torch.arange(count),
        dataset.chemistry_index.long(),
    ] = 1.0
    condition[:, 6] = (nominal_capacity_ah / 100.0).clamp(0.0, 2.0)
    condition[:, 7] = (
        (dataset.temperature_c.mean(dim=1) - 25.0) / 20.0
    ).clamp(-1.5, 2.0)
    condition[:, 8] = (
        dataset.current_c_rate.abs().mean(dim=1) / 5.0
    ).clamp(0.0, 1.0)
    condition[:, 9] = 1.0
    condition[:, 10] = 1.0
    return condition


def _batch_loss(
    head: BatterySPMPINNHead,
    dataset,
    condition: torch.Tensor,
    nominal_capacity_ah: torch.Tensor,
    indices: torch.Tensor,
    device: torch.device,
) -> tuple[torch.Tensor, dict[str, float]]:
    current = dataset.current_c_rate[indices].to(device)
    voltage = dataset.voltage_v[indices].to(device)
    soc = dataset.soc[indices].to(device)
    capacity = soc * nominal_capacity_ah[indices, None].to(device)
    curves = torch.stack((voltage, current, capacity, soc), dim=1).unsqueeze(1)
    mask = torch.ones(indices.numel(), 1, device=device)
    cycle_features = torch.tensor(
        (0.995, 0.94),
        device=device,
    ).reshape(1, 1, 2).expand(indices.numel(), 1, 2)
    soh_input = torch.ones(indices.numel(), 1, 1, device=device)
    embedding = torch.zeros(indices.numel(), 512, device=device)

    state = head(
        embedding,
        curves,
        mask,
        cycle_features,
        soh_input,
        condition[indices].to(device),
    )
    target_concentration = dataset.concentration[indices].to(device)
    target_diffusivity = dataset.diffusivity[indices].to(device)
    target_flux = dataset.surface_flux_scale[indices].to(device)

    concentration_loss = F.smooth_l1_loss(
        state["concentration"],
        target_concentration,
    )
    diffusivity_loss = F.mse_loss(
        torch.log(state["diffusivity"].clamp_min(1e-6)),
        torch.log(target_diffusivity.clamp_min(1e-6)),
    )
    flux_loss = F.mse_loss(
        torch.log(state["flux_scale"].clamp_min(1e-6)),
        torch.log(target_flux.clamp_min(1e-6)),
    )
    voltage_loss = F.smooth_l1_loss(
        state["predicted_voltage"],
        voltage,
    )
    # The synthetic generator uses 0.025 V per C-rate as its ohmic term.
    resistance_loss = F.mse_loss(
        torch.log(state["resistance_v_per_c"].clamp_min(1e-6)),
        torch.full_like(state["resistance_v_per_c"], math.log(0.025)),
    )
    total = (
        4.0 * concentration_loss
        + diffusivity_loss
        + flux_loss
        + 2.0 * voltage_loss
        + 0.5 * resistance_loss
    )
    metrics = {
        "loss": float(total.detach()),
        "concentration": float(concentration_loss.detach()),
        "diffusivity": float(diffusivity_loss.detach()),
        "flux": float(flux_loss.detach()),
        "voltage": float(voltage_loss.detach()),
        "resistance": float(resistance_loss.detach()),
    }
    return total, metrics


def _evaluate(
    head: BatterySPMPINNHead,
    dataset,
    condition: torch.Tensor,
    nominal_capacity_ah: torch.Tensor,
    indices: torch.Tensor,
    batch_size: int,
    device: torch.device,
) -> dict[str, float]:
    totals: dict[str, float] = {}
    batches = 0
    head.eval()
    with torch.no_grad():
        for start in range(0, indices.numel(), batch_size):
            batch_indices = indices[start : start + batch_size]
            _, metrics = _batch_loss(
                head,
                dataset,
                condition,
                nominal_capacity_ah,
                batch_indices,
                device,
            )
            for name, value in metrics.items():
                totals[name] = totals.get(name, 0.0) + value
            batches += 1
    return {name: value / max(batches, 1) for name, value in totals.items()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("checkpoints/spm-pinn-head-pretrain-v1"),
    )
    parser.add_argument("--scenarios", type=int, default=512)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--seed", type=int, default=2026)
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    dataset = generate_dimensionless_spm_dataset(
        scenarios=args.scenarios,
        time_steps=48,
        radial_points=10,
        seed=args.seed,
    )
    generator = torch.Generator().manual_seed(args.seed + 17)
    nominal_capacity_ah = torch.exp(
        torch.empty(args.scenarios).uniform_(
            math.log(1.0),
            math.log(100.0),
            generator=generator,
        )
    )
    condition = _condition_tensor(dataset, nominal_capacity_ah)
    order = torch.randperm(args.scenarios, generator=generator)
    validation_count = max(32, args.scenarios // 5)
    validation_indices = order[:validation_count]
    training_indices = order[validation_count:]

    head = BatterySPMPINNHead(
        embedding_dim=512,
        prediction_length=256,
        radial_points=10,
        collocation_steps=48,
        hidden_dim=64,
        condition_dim=11,
    ).to(device)
    optimizer = torch.optim.AdamW(
        head.parameters(),
        lr=args.learning_rate,
        weight_decay=1e-5,
    )

    history = []
    best_loss = float("inf")
    best_state = None
    for epoch in range(args.epochs):
        head.train()
        permutation = training_indices[
            torch.randperm(training_indices.numel(), generator=generator)
        ]
        for start in range(0, permutation.numel(), args.batch_size):
            indices = permutation[start : start + args.batch_size]
            optimizer.zero_grad(set_to_none=True)
            loss, _ = _batch_loss(
                head,
                dataset,
                condition,
                nominal_capacity_ah,
                indices,
                device,
            )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(head.parameters(), 1.0)
            optimizer.step()
        validation = _evaluate(
            head,
            dataset,
            condition,
            nominal_capacity_ah,
            validation_indices,
            args.batch_size,
            device,
        )
        history.append({"epoch": epoch + 1, **validation})
        print(
            f"Epoch {epoch + 1}/{args.epochs}: "
            f"val={validation['loss']:.6f}, "
            f"D={validation['diffusivity']:.6f}, "
            f"flux={validation['flux']:.6f}, "
            f"V={validation['voltage']:.6f}",
            flush=True,
        )
        if validation["loss"] < best_loss:
            best_loss = validation["loss"]
            best_state = {
                name: value.detach().cpu().contiguous()
                for name, value in head.state_dict().items()
            }

    if best_state is None:
        raise RuntimeError("预训练没有产生有效 checkpoint。")
    args.output.mkdir(parents=True, exist_ok=True)
    save_file(best_state, str(args.output / "physics_head.safetensors"))
    metadata = {
        "status": "research-pretrain-only",
        "production_action": "none",
        "seed": args.seed,
        "scenarios": args.scenarios,
        "known_parameter_targets": [
            "dimensionless diffusivity",
            "surface flux scale",
            "equivalent resistance V/C-rate",
            "concentration field",
            "terminal voltage",
        ],
        "limitations": (
            "Synthetic SPM anchors parameter semantics but does not make "
            "material-intrinsic diffusivity identifiable without particle "
            "radius/EIS/internal-state measurements."
        ),
        "best_validation_loss": best_loss,
        "history": history,
    }
    (args.output / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(args.output.resolve(), flush=True)


if __name__ == "__main__":
    main()
