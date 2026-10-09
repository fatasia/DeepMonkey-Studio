"""Reproducible SPM scenarios for isolated PINO candidate experiments."""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

import torch
from torch import Tensor

from research.spm_physics import (
    finite_volume_rhs,
    radial_volume_average,
    surface_flux,
)


@dataclass
class SPMTensorDataset:
    current_c_rate: Tensor
    temperature_c: Tensor
    delta_time: Tensor
    initial_concentration: Tensor
    diffusivity: Tensor
    surface_flux_scale: Tensor
    chemistry_index: Tensor
    concentration: Tensor
    voltage_v: Tensor
    soc: Tensor
    measured_temperature_c: Tensor
    capacity_ratio: Tensor
    scenario_family: list[str]
    initial_soc: Tensor
    duration_hours: Tensor
    group_id: list[str] | None = None
    metadata: dict[str, object] = field(default_factory=dict)

    def tensors(self) -> tuple[Tensor, ...]:
        return (
            self.current_c_rate,
            self.temperature_c,
            self.delta_time,
            self.initial_concentration,
            self.diffusivity,
            self.surface_flux_scale,
            self.chemistry_index,
            self.concentration,
            self.voltage_v,
            self.soc,
            self.initial_soc,
            self.duration_hours,
            self.measured_temperature_c,
            self.capacity_ratio,
        )


def generate_current_profile(
    family: str,
    steps: int,
    generator: torch.Generator,
) -> Tensor:
    time = torch.linspace(0.0, 1.0, steps)
    amplitude = float(torch.empty(1).uniform_(0.25, 1.8, generator=generator))
    direction = -1.0 if float(torch.rand(1, generator=generator)) < 0.35 else 1.0
    if family == "constant":
        return torch.full((steps,), direction * amplitude)
    if family == "triangular":
        triangle = 1.0 - 2.0 * (2.0 * time - 1.0).abs()
        return direction * amplitude * triangle
    if family == "pulse":
        period = max(4, steps // 8)
        pulse = ((torch.arange(steps) // period) % 2).float()
        return direction * amplitude * pulse
    if family == "random":
        knots = max(5, steps // 8)
        coarse = torch.randn(knots, generator=generator)
        smooth = torch.nn.functional.interpolate(
            coarse.reshape(1, 1, -1),
            size=steps,
            mode="linear",
            align_corners=True,
        ).reshape(-1)
        smooth = smooth / smooth.abs().amax().clamp_min(1e-6)
        return amplitude * smooth
    raise ValueError(f"未知工况族：{family}")


def _simulate_concentration(
    current: Tensor,
    initial: Tensor,
    diffusivity: Tensor,
    radial_points: int,
    flux_scale: float,
) -> tuple[Tensor, Tensor]:
    steps = current.numel()
    delta_time = torch.zeros(steps)
    delta_time[1:] = 1.0 / max(steps - 1, 1)
    state = initial.reshape(1, 1, 1, 2).expand(1, 1, radial_points, 2).clone()
    trajectory = [state[:, 0]]
    for index in range(1, steps):
        imposed = surface_flux(current[index - 1:index].reshape(1, 1), flux_scale)
        rhs = finite_volume_rhs(
            state,
            diffusivity.reshape(1, 2),
            imposed,
        )
        next_state = state[:, 0] + delta_time[index] * rhs[:, 0]
        # Generated parameter ranges keep clipping rare; the clamp is a hard
        # physical bound and its incidence is recorded by candidate metrics.
        state = next_state.clamp(0.001, 0.999).unsqueeze(1)
        trajectory.append(state[:, 0])
    return torch.stack(trajectory, dim=1).squeeze(0), delta_time


def generate_dimensionless_spm_dataset(
    scenarios: int = 128,
    *,
    time_steps: int = 64,
    radial_points: int = 24,
    seed: int = 2026,
    flux_scale: float = 0.01,
) -> SPMTensorDataset:
    if scenarios < 8:
        raise ValueError("至少需要 8 个工况样本。")
    if time_steps < 8:
        raise ValueError("time_steps 必须至少为 8。")
    generator = torch.Generator().manual_seed(seed)
    randomizer = random.Random(seed)
    families = ("constant", "triangular", "pulse", "random")
    current_items = []
    temperature_items = []
    delta_items = []
    initial_items = []
    diffusivity_items = []
    surface_flux_items = []
    chemistry_items = []
    concentration_items = []
    voltage_items = []
    soc_items = []
    initial_soc_items = []
    duration_items = []
    family_items = []
    chemistry_offsets = torch.tensor([0.00, 0.08, 0.12, 0.04, 0.06, 0.02])

    for index in range(scenarios):
        family = families[index % len(families)]
        current = generate_current_profile(family, time_steps, generator)
        temperature_base = float(torch.empty(1).uniform_(10.0, 45.0, generator=generator))
        temperature_swing = float(torch.empty(1).uniform_(0.0, 5.0, generator=generator))
        temperature = temperature_base + temperature_swing * torch.sin(
            torch.linspace(0.0, math.pi, time_steps)
        )
        initial_soc = float(torch.empty(1).uniform_(0.20, 0.85, generator=generator))
        initial = torch.tensor([initial_soc, 1.0 - initial_soc])
        diffusivity = torch.empty(2).uniform_(0.008, 0.025, generator=generator)
        chemistry = randomizer.randrange(6)
        concentration, delta_time = _simulate_concentration(
            current,
            initial,
            diffusivity,
            radial_points,
            flux_scale,
        )
        average = radial_volume_average(concentration)
        soc = average[:, 0]
        surface = concentration[:, -1, :]
        polarization = (surface - average)
        voltage = (
            3.0
            + 1.15 * soc
            + chemistry_offsets[chemistry]
            + 0.025 * current
            + 0.12 * (polarization[:, 0] - polarization[:, 1])
            - 0.0015 * (temperature - 25.0)
        )
        current_items.append(current)
        temperature_items.append(temperature)
        delta_items.append(delta_time)
        initial_items.append(initial)
        diffusivity_items.append(diffusivity)
        surface_flux_items.append(torch.full((2,), flux_scale))
        chemistry_items.append(chemistry)
        concentration_items.append(concentration)
        voltage_items.append(voltage)
        soc_items.append(soc)
        initial_soc_items.append(initial_soc)
        duration_items.append(1.0)
        family_items.append(family)

    return SPMTensorDataset(
        current_c_rate=torch.stack(current_items),
        temperature_c=torch.stack(temperature_items),
        delta_time=torch.stack(delta_items),
        initial_concentration=torch.stack(initial_items),
        diffusivity=torch.stack(diffusivity_items),
        surface_flux_scale=torch.stack(surface_flux_items),
        chemistry_index=torch.tensor(chemistry_items, dtype=torch.long),
        concentration=torch.stack(concentration_items),
        voltage_v=torch.stack(voltage_items),
        soc=torch.stack(soc_items),
        measured_temperature_c=torch.stack(temperature_items),
        capacity_ratio=torch.ones(scenarios, dtype=torch.float32),
        scenario_family=family_items,
        initial_soc=torch.tensor(initial_soc_items, dtype=torch.float32),
        duration_hours=torch.tensor(duration_items, dtype=torch.float32),
        metadata={
            "format": "dimensionless-conservative-spm-v2",
            "soc_definition": "negative-particle-average-fixture",
        },
    )


def load_spm_npz(path: str) -> SPMTensorDataset:
    """Load a raw PyBaMM candidate artifact into the shared tensor contract."""

    import numpy as np

    with np.load(path, allow_pickle=False) as payload:
        required = {
            "current_c_rate",
            "temperature_c",
            "delta_time",
            "initial_concentration",
            "diffusivity",
            "surface_flux_scale",
            "chemistry_index",
            "concentration",
            "voltage_v",
            "soc",
            "scenario_family",
        }
        missing = required - set(payload.files)
        if missing:
            raise ValueError(f"SPM NPZ 缺少字段：{', '.join(sorted(missing))}")

        def floating(name: str) -> Tensor:
            return torch.from_numpy(np.array(payload[name], copy=True)).float()

        metadata: dict[str, object] = {}
        if "metadata_json" in payload.files:
            import json

            metadata = json.loads(str(payload["metadata_json"].item()))
        multifidelity = bool(metadata.get("multifidelity", False))
        soc = (
            floating("measured_soc")
            if multifidelity and "measured_soc" in payload.files
            else floating("soc")
        )
        voltage = (
            floating("measured_voltage_v")
            if multifidelity and "measured_voltage_v" in payload.files
            else floating("voltage_v")
        )
        measured_temperature = (
            floating("measured_temperature_c")
            if "measured_temperature_c" in payload.files
            else floating("temperature_c")
        )
        capacity_ratio = (
            floating("capacity_ratio").reshape(-1)
            if "capacity_ratio" in payload.files
            else torch.ones(soc.shape[0], dtype=torch.float32)
        )
        initial_soc = (
            floating("initial_soc").reshape(-1)
            if "initial_soc" in payload.files
            else soc[:, 0].clone()
        )
        duration_hours = (
            floating("duration_hours").reshape(-1)
            if "duration_hours" in payload.files
            else torch.ones(soc.shape[0], dtype=torch.float32)
        )
        return SPMTensorDataset(
            current_c_rate=floating("current_c_rate"),
            temperature_c=floating("temperature_c"),
            delta_time=floating("delta_time"),
            initial_concentration=floating("initial_concentration"),
            diffusivity=floating("diffusivity"),
            surface_flux_scale=floating("surface_flux_scale"),
            chemistry_index=torch.from_numpy(
                np.array(payload["chemistry_index"], copy=True)
            ).long(),
            concentration=floating("concentration"),
            voltage_v=voltage,
            soc=soc,
            measured_temperature_c=measured_temperature,
            capacity_ratio=capacity_ratio,
            scenario_family=[
                str(item) for item in payload["scenario_family"].tolist()
            ],
            initial_soc=initial_soc,
            duration_hours=duration_hours,
            group_id=(
                [str(item) for item in payload["group_id"].tolist()]
                if "group_id" in payload.files
                else None
            ),
            metadata=metadata,
        )
