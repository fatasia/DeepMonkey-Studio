import unittest
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import sys

import torch

from research.battery_spm_pinn import (
    BatterySPMPINNHead,
    battery_spm_pinn_losses,
    gradient_conflict_diagnostics,
)


class BatterySPMPINNTest(unittest.TestCase):
    def test_gradient_conflict_controller_attenuates_only_opposition(self):
        aligned_parameter = torch.nn.Parameter(torch.tensor(0.0))
        aligned = gradient_conflict_diagnostics(
            (aligned_parameter - 1.0).square(),
            (aligned_parameter - 1.0).square(),
            [aligned_parameter],
            minimum_multiplier=0.2,
        )
        self.assertAlmostEqual(aligned.cosine, 1.0, places=6)
        self.assertAlmostEqual(aligned.multiplier, 1.0, places=6)

        conflict_parameter = torch.nn.Parameter(torch.tensor(0.0))
        conflicting = gradient_conflict_diagnostics(
            (conflict_parameter - 1.0).square(),
            (conflict_parameter + 1.0).square(),
            [conflict_parameter],
            minimum_multiplier=0.2,
        )
        self.assertAlmostEqual(conflicting.cosine, -1.0, places=6)
        self.assertAlmostEqual(conflicting.multiplier, 0.2, places=6)

    def _inputs(self):
        batch, cycles, points = 2, 4, 32
        soc = torch.cat(
            (
                torch.linspace(0.1, 0.9, points // 2),
                torch.linspace(0.9, 0.1, points // 2),
            )
        )
        current = torch.cat(
            (
                torch.full((points // 2,), 0.5),
                torch.full((points // 2,), -0.5),
            )
        )
        voltage = 3.0 + 1.1 * soc + 0.08 * current
        curve = torch.stack((voltage, current, soc * 3.2, soc), dim=0)
        curves = curve.reshape(1, 1, 4, points).repeat(batch, cycles, 1, 1)
        mask = torch.ones(batch, cycles)
        cycle_features = torch.tensor([0.995, 0.94]).reshape(1, 1, 2)
        cycle_features = cycle_features.repeat(batch, cycles, 1)
        soh_input = torch.linspace(1.0, 0.9, cycles).reshape(1, cycles, 1)
        soh_input = soh_input.repeat(batch, 1, 1)
        return curves, mask, cycle_features, soh_input

    def test_head_learns_bounded_fields_and_monotone_physical_trajectory(self):
        head = BatterySPMPINNHead(
            embedding_dim=16,
            prediction_length=64,
            radial_points=6,
            collocation_steps=16,
            hidden_dim=24,
        )
        curves, mask, features, soh = self._inputs()
        state = head(
            torch.randn(2, 16),
            curves,
            mask,
            features,
            soh,
        )

        self.assertEqual(state["concentration"].shape, (2, 16, 6, 2))
        self.assertEqual(state["physical_soh"].shape, (2, 64))
        self.assertTrue(bool((state["concentration"] > 0).all()))
        self.assertTrue(bool((state["concentration"] < 1).all()))
        self.assertTrue(
            bool((torch.diff(state["physical_soh"], dim=1) <= 0).all())
        )
        charge = state["current_c_rate"] > 0
        discharge = state["current_c_rate"] < 0
        self.assertTrue(
            bool(
                (
                    state["predicted_voltage"][charge]
                    > state["ocv"][charge]
                ).all()
            )
        )
        self.assertTrue(
            bool(
                (
                    state["predicted_voltage"][discharge]
                    < state["ocv"][discharge]
                ).all()
            )
        )
        self.assertTrue(bool((state["diffusivity"] > 0).all()))
        self.assertTrue(bool((state["flux_scale"] > 0).all()))
        self.assertTrue(bool((state["heat_generation"] >= 0).all()))

    def test_full_physics_objective_is_finite_and_backpropagates(self):
        head = BatterySPMPINNHead(
            embedding_dim=16,
            prediction_length=64,
            radial_points=6,
            collocation_steps=16,
            hidden_dim=24,
        )
        curves, mask, features, soh = self._inputs()
        embedding = torch.randn(2, 16, requires_grad=True)
        state = head(embedding, curves, mask, features, soh)
        prediction = torch.linspace(1.0, -0.1, 64).reshape(1, -1).repeat(2, 1)
        prediction.requires_grad_()
        trajectory_mask = torch.ones_like(prediction)

        total, terms = battery_spm_pinn_losses(
            state,
            prediction,
            trajectory_mask,
        )
        self.assertTrue(bool(torch.isfinite(total)))
        self.assertEqual(
            set(terms),
            {
                "pde",
                "boundary",
                "conservation",
                "initial",
                "soc_observation",
                "lithium_inventory",
                "voltage_observation",
                "energy_efficiency",
                "dissipation",
                "aging_ode",
                "physical_trajectory",
                "stoichiometry_window",
                "ocv_anchor",
                "parameter_prior",
                "physical_observation",
            },
        )
        total.backward()
        self.assertIsNotNone(embedding.grad)
        self.assertIsNotNone(head.parameter_head.weight.grad)
        self.assertIsNotNone(head.field_decoder[0].weight.grad)
        self.assertIsNotNone(prediction.grad)

    def test_condition_exposes_engineering_parameters_and_identifiability(self):
        head = BatterySPMPINNHead(
            embedding_dim=16,
            prediction_length=64,
            radial_points=6,
            collocation_steps=16,
            hidden_dim=24,
        )
        curves, mask, features, soh = self._inputs()
        condition = torch.zeros(2, 11)
        condition[:, 1] = 1.0
        condition[:, 6] = 0.58
        condition[:, 7] = 0.5
        condition[:, 8] = 0.2
        condition[:, 9] = 1.0
        condition[:, 10] = 1.0
        state = head(
            torch.randn(2, 16),
            curves,
            mask,
            features,
            soh,
            condition,
        )
        self.assertTrue(
            torch.allclose(
                state["nominal_capacity_ah"],
                torch.full((2,), 58.0),
            )
        )
        self.assertTrue(
            torch.allclose(
                state["equivalent_resistance_ohm"],
                state["resistance_v_per_c"] / 58.0,
            )
        )
        self.assertTrue(
            bool(
                (
                    (state["identifiability_score"] >= 0.0)
                    & (state["identifiability_score"] <= 1.0)
                ).all()
            )
        )

    def test_batterymformer_opt_in_returns_physics_without_changing_legacy_api(self):
        source = Path(__file__).resolve().parents[1] / "vendor" / "BatteryMFormer"
        if not (source / "models" / "BatteryMFormer.py").is_file():
            self.skipTest("Optional upstream BatteryMFormer integration is not bundled")
        sys.path.insert(0, str(source))
        try:
            spec = importlib.util.spec_from_file_location(
                "test_official_batterymformer_spm",
                source / "models" / "BatteryMFormer.py",
            )
            self.assertIsNotNone(spec)
            self.assertIsNotNone(spec.loader)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            if sys.path[0] == str(source):
                sys.path.pop(0)
        config = SimpleNamespace(
            seq_len=1,
            top_k=2,
            early_cycle_threshold=4,
            pred_len=64,
            d_model=16,
            d_ff=16,
            d_ffs=16,
            d_llm=8,
            n_heads=4,
            e_layers=1,
            e_layers2=1,
            d_layers=1,
            dropout=0.0,
            kernel_size=4,
            activation="gelu",
            factor=1,
            charge_discharge_length=32,
            k_dim=16,
            enc_in=3,
            num_query=2,
            cnn_channels=4,
            stride=4,
            num_slots=8,
            temperature=1.0,
            num_segments=4,
            enable_spm_pinn=True,
            spm_radial_points=6,
            spm_collocation_steps=16,
            spm_hidden_dim=24,
        )
        model = module.Model(config)
        chemistry_condition = torch.ones(2, 11)
        model.spm_condition_ablation = "chemistry"
        ablated_condition = model._ablate_physics_condition(
            chemistry_condition
        )
        self.assertTrue(
            torch.equal(
                ablated_condition[:, :6],
                torch.zeros(2, 6),
            )
        )
        self.assertTrue(
            torch.equal(
                ablated_condition[:, 6:],
                torch.ones(2, 5),
            )
        )
        self.assertTrue(torch.equal(chemistry_condition, torch.ones(2, 11)))
        model.spm_condition_ablation = "none"
        curves, mask, features, soh = self._inputs()
        condition = torch.zeros(2, 1, 8)
        trajectory = torch.linspace(1.0, -0.1, 64).repeat(2, 1)
        trajectory_mask = torch.ones_like(trajectory)
        result = model(
            cycle_curve_data=curves[:, :, :3],
            curve_attn_mask=mask,
            aging_condition_embedding=condition,
            soh_trajectory=trajectory,
            trajectory_mask=trajectory_mask,
            soc_input=curves[:, :, 3],
            soh_input=soh,
            cycle_level_features=features,
            life_labels=torch.tensor([100.0, 120.0]),
            return_physics=True,
        )
        self.assertEqual(len(result), 6)
        output, *_, state = result
        self.assertEqual(output.shape, (2, 64))
        self.assertIsNotNone(state)
        self.assertEqual(state["concentration"].shape, (2, 16, 6, 2))
        (output.mean() + state["concentration"].mean()).backward()
        self.assertIsNotNone(model.output_extrapolation.weight.grad)
        self.assertIsNotNone(model.physics_head.parameter_head.weight.grad)


if __name__ == "__main__":
    unittest.main()
