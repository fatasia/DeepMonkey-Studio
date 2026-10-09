from __future__ import annotations

import unittest
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

import torch
import numpy as np

from models.spm_pino_transformer import (
    SPMPINOTransformer,
    SPMPINOTransformerConfig,
)
from research.multi_constraint_balance import MultiConstraintBalancer
from research.spm_dataset import generate_dimensionless_spm_dataset, load_spm_npz
from research.spm_physics import (
    detached_residual_weights,
    spm_physics_losses,
    spm_residuals,
)
from train_spm_pino_transformer_candidate import (
    coulomb_soc_reference,
    freeze_v10_backbone_for_multiphysics,
    split_masks,
)


class SPMPINOTransformerTest(unittest.TestCase):
    def test_pybamm_npz_loader_preserves_candidate_tensor_contract(self):
        source = generate_dimensionless_spm_dataset(
            8,
            time_steps=12,
            radial_points=10,
            seed=12,
        )
        names = (
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
        )
        with TemporaryDirectory() as directory:
            path = Path(directory) / "spm-candidate.npz"
            np.savez(
                path,
                **{
                    name: getattr(source, name).numpy()
                    for name in names
                },
                scenario_family=np.asarray(source.scenario_family),
            )
            loaded = load_spm_npz(str(path))
        self.assertEqual(loaded.scenario_family, source.scenario_family)
        self.assertTrue(torch.allclose(loaded.concentration, source.concentration))
        self.assertEqual(loaded.chemistry_index.dtype, torch.long)

    def test_synthetic_spm_dataset_is_conservative_and_reproducible(self):
        first = generate_dimensionless_spm_dataset(
            8,
            time_steps=16,
            radial_points=12,
            seed=77,
        )
        second = generate_dimensionless_spm_dataset(
            8,
            time_steps=16,
            radial_points=12,
            seed=77,
        )
        self.assertEqual(tuple(first.concentration.shape), (8, 16, 12, 2))
        self.assertTrue(torch.allclose(first.current_c_rate, second.current_c_rate))
        self.assertTrue(torch.allclose(first.concentration, second.concentration))
        residual = spm_residuals(
            first.concentration[:1],
            first.current_c_rate[:1],
            first.delta_time[:1],
            first.diffusivity[:1],
            flux_scale=first.surface_flux_scale[:1],
        )
        self.assertLess(float(residual.conservation.abs().mean()), 1e-5)

    def test_grouped_split_keeps_source_cycles_out_of_other_partitions(self):
        dataset = generate_dimensionless_spm_dataset(
            24,
            time_steps=12,
            radial_points=10,
            seed=77,
        )
        family_counts: dict[str, int] = {}
        group_ids = []
        for family in dataset.scenario_family:
            member = family_counts.get(family, 0)
            group_ids.append(f"{family}:cycle-{member // 2}")
            family_counts[family] = member + 1
        dataset.group_id = group_ids
        masks = split_masks(dataset, 2026)
        split_groups = {
            name: {
                group_ids[index]
                for index in torch.where(mask)[0].tolist()
            }
            for name, mask in masks.items()
        }
        self.assertTrue(split_groups["train"].isdisjoint(split_groups["validation"]))
        self.assertTrue(split_groups["train"].isdisjoint(split_groups["test"]))
        self.assertTrue(split_groups["validation"].isdisjoint(split_groups["test"]))

    def test_local_residual_weights_are_detached_bounded_and_normalized(self):
        residual = torch.tensor(
            [[[0.1], [0.2], [10.0]]],
            requires_grad=True,
        )
        weights = detached_residual_weights(residual, max_weight=3.0)
        self.assertFalse(weights.requires_grad)
        self.assertAlmostEqual(float(weights.mean()), 1.0, places=5)
        self.assertLessEqual(float(weights.max()), 3.0)
        self.assertGreater(float(weights[0, -1, 0]), float(weights[0, 0, 0]))

    def test_pino_transformer_routes_and_backpropagates_at_two_resolutions(self):
        torch.manual_seed(3)
        dataset = generate_dimensionless_spm_dataset(
            8,
            time_steps=12,
            radial_points=10,
            seed=3,
        )
        model = SPMPINOTransformer(
            SPMPINOTransformerConfig(
                model_dim=24,
                attention_heads=4,
                transformer_layers=1,
                operator_width=16,
                operator_layers=1,
                radial_modes=4,
                dropout=0.0,
            )
        )
        model.set_radial_resolution(10)
        output = model(*dataset.tensors()[:7])
        self.assertEqual(tuple(output.concentration.shape), (8, 12, 10, 2))
        self.assertEqual(tuple(output.voltage_v.shape), (8, 12))
        self.assertTrue(
            torch.allclose(
                output.route_weights.sum(dim=-1),
                torch.ones(8),
                atol=1e-6,
            )
        )
        physics, _ = spm_physics_losses(
            output.concentration,
            dataset.current_c_rate,
            dataset.delta_time,
            dataset.diffusivity,
            dataset.initial_concentration,
            flux_scale=dataset.surface_flux_scale,
        )
        loss = (
            torch.nn.functional.mse_loss(
                output.concentration,
                dataset.concentration,
            )
            + torch.nn.functional.mse_loss(output.voltage_v, dataset.voltage_v)
            + sum(physics.values())
        )
        loss.backward()
        self.assertTrue(
            any(parameter.grad is not None for parameter in model.parameters())
        )

        model.set_radial_resolution(14)
        transferred = model(*dataset.tensors()[:7])
        self.assertEqual(tuple(transferred.concentration.shape), (8, 12, 14, 2))

    def test_soc_head_v2_anchors_initial_state_and_preserves_current_direction(self):
        torch.manual_seed(19)
        dataset = generate_dimensionless_spm_dataset(
            8,
            time_steps=12,
            radial_points=10,
            seed=19,
        )
        model = SPMPINOTransformer(
            SPMPINOTransformerConfig(
                model_dim=24,
                attention_heads=4,
                transformer_layers=1,
                operator_width=16,
                operator_layers=1,
                radial_modes=4,
                dropout=0.0,
                soc_head_version=4,
            )
        )
        model.set_radial_resolution(10)
        current = dataset.current_c_rate.abs()
        charging = model(
            current,
            *dataset.tensors()[1:7],
            initial_soc=dataset.initial_soc,
            duration_hours=dataset.duration_hours,
        )
        discharging = model(
            -current,
            *dataset.tensors()[1:7],
            initial_soc=dataset.initial_soc,
            duration_hours=dataset.duration_hours,
        )
        self.assertTrue(torch.allclose(
            charging.soc[:, 0],
            dataset.initial_soc,
            atol=1e-6,
        ))
        self.assertTrue(torch.allclose(
            discharging.soc[:, 0],
            dataset.initial_soc,
            atol=1e-6,
        ))
        self.assertGreater(
            float(
                (charging.soc[:, -1] - charging.soc[:, 0])
                .mean()
                .detach()
            ),
            0.0,
        )
        self.assertLess(
            float(
                (discharging.soc[:, -1] - discharging.soc[:, 0])
                .mean()
                .detach()
            ),
            0.0,
        )
        self.assertLessEqual(
            float(charging.soc_correction.abs().max().detach()),
            model.config.soc_correction_limit + 1e-6,
        )
        charging.soc.mean().backward()
        self.assertTrue(any(
            parameter.grad is not None
            for parameter in model.soc_correction_head.parameters()
        ))

    def test_health_condition_v2_does_not_double_scale_coulomb_soc(self):
        dataset = generate_dimensionless_spm_dataset(
            8,
            time_steps=12,
            radial_points=10,
            seed=29,
        )
        batch = list(dataset.tensors())
        batch[13] = torch.full_like(batch[13], 0.8)
        unscaled = coulomb_soc_reference(tuple(batch), health_scaled=False)
        legacy_scaled = coulomb_soc_reference(tuple(batch), health_scaled=True)
        self.assertGreater(
            float((legacy_scaled - unscaled).abs().mean()),
            1e-4,
        )
        model = SPMPINOTransformer(
            SPMPINOTransformerConfig(
                model_dim=24,
                attention_heads=4,
                transformer_layers=1,
                operator_width=16,
                operator_layers=1,
                radial_modes=4,
                dropout=0.0,
                soc_head_version=4,
                health_conditioned_version=2,
            )
        )
        torch.nn.init.zeros_(model.soc_correction_head[-1].weight)
        torch.nn.init.zeros_(model.soc_correction_head[-1].bias)
        output = model(
            *tuple(batch[:7]),
            initial_soc=batch[10],
            duration_hours=batch[11],
            capacity_ratio=batch[13],
        )
        self.assertTrue(torch.allclose(output.soc, unscaled, atol=1e-6))

    def test_sparse_dynamic_route_skips_operator_for_low_physics_risk(self):
        dataset = generate_dimensionless_spm_dataset(
            8,
            time_steps=12,
            radial_points=10,
            seed=31,
        )
        model = SPMPINOTransformer(
            SPMPINOTransformerConfig(
                model_dim=24,
                attention_heads=4,
                transformer_layers=1,
                operator_width=16,
                operator_layers=1,
                radial_modes=4,
                dropout=0.0,
            )
        )
        model.set_radial_resolution(10)
        model._risk_summary = lambda *args: torch.zeros(8, 6)  # type: ignore[method-assign]
        original_forward = model.operator_input.forward

        def fail_if_called(*args, **kwargs):
            raise AssertionError("低风险样本不应执行重算子专家。")

        model.operator_input.forward = fail_if_called  # type: ignore[method-assign]
        try:
            output = model(*dataset.tensors()[:7], route_mode="dynamic_sparse")
        finally:
            model.operator_input.forward = original_forward  # type: ignore[method-assign]
        self.assertTrue(torch.equal(
            output.route_weights,
            torch.tensor([[1.0, 0.0]]).expand(8, 2),
        ))
        self.assertTrue(torch.allclose(
            output.operator_concentration,
            output.fast_concentration,
        ))

    def test_router_upgrade_adds_only_leakage_free_risk_features(self):
        dataset = generate_dimensionless_spm_dataset(
            8,
            time_steps=12,
            radial_points=10,
            seed=32,
        )
        model = SPMPINOTransformer(
            SPMPINOTransformerConfig(
                model_dim=24,
                attention_heads=4,
                transformer_layers=1,
                operator_width=16,
                operator_layers=1,
                radial_modes=4,
                dropout=0.0,
            )
        )
        fast_weight = model.fast_head[-1].weight.detach().clone()
        model.upgrade_router(2)
        risk = model._risk_summary(
            dataset.concentration[:4],
            dataset.current_c_rate[:4],
            dataset.temperature_c[:4],
            dataset.delta_time[:4],
            dataset.diffusivity[:4],
            dataset.surface_flux_scale[:4],
            dataset.initial_soc[:4],
            dataset.duration_hours[:4],
        )
        self.assertEqual(tuple(risk.shape), (4, 15))
        self.assertEqual(model.router.network[0].in_features, 15)
        self.assertTrue(torch.equal(model.fast_head[-1].weight, fast_weight))

    def test_multi_constraint_balancer_reuses_gradient_conflict_control(self):
        parameter = torch.nn.Parameter(torch.tensor([0.5, -0.5]))
        data_loss = (parameter - torch.tensor([1.0, 1.0])).pow(2).mean()
        constraints = {
            "pde": (parameter + 2.0).pow(2).mean(),
            "boundary": parameter.pow(2).mean(),
            "conservation": (parameter.sum() - 0.1).pow(2),
            "initial": (parameter[0] - 0.4).pow(2),
        }
        balancer = MultiConstraintBalancer(
            max_weight=1.0,
            ema_decay=0.0,
            update_every=1,
        )
        diagnostics = balancer.update(
            data_loss,
            constraints,
            [parameter],
            step=0,
        )
        self.assertEqual(set(diagnostics.weights), set(constraints))
        self.assertTrue(all(weight > 0 for weight in diagnostics.weights.values()))
        total = data_loss + balancer.weighted_loss(constraints)
        total.backward()
        self.assertIsNotNone(parameter.grad)

    def test_multi_constraint_balancer_honours_named_weight_floor(self):
        parameter = torch.nn.Parameter(torch.tensor([0.5, -0.5]))
        data_loss = parameter.pow(2).mean()
        constraints = {
            "pde": (parameter * 1000.0).pow(2).mean(),
            "thermal_dynamics": (parameter * 1000.0).pow(2).mean(),
        }
        balancer = MultiConstraintBalancer(
            {"pde": 0.1, "thermal_dynamics": 0.1},
            min_weights={"thermal_dynamics": 0.002},
            max_weight=1.0,
            ema_decay=0.0,
            update_every=1,
        )
        diagnostics = balancer.update(
            data_loss,
            constraints,
            [parameter],
            step=0,
        )
        self.assertGreaterEqual(
            diagnostics.weights["thermal_dynamics"],
            0.002,
        )
        self.assertLess(
            diagnostics.weights["pde"],
            diagnostics.weights["thermal_dynamics"],
        )

    def test_degradation_context_predicts_bounded_transfer_prior(self):
        config = SPMPINOTransformerConfig(
            model_dim=16,
            attention_heads=4,
            transformer_layers=1,
            operator_width=8,
            operator_layers=1,
            radial_modes=3,
            dropout=0.0,
            degradation_context_version=1,
        )
        model = SPMPINOTransformer(config)
        embedding, prior = model.encode_degradation_context(
            torch.zeros(3, config.degradation_context_features)
        )
        self.assertEqual(tuple(embedding.shape), (3, config.model_dim))
        self.assertEqual(tuple(prior.shape), (3, 2))
        self.assertTrue(torch.all((prior[:, 0] >= 0) & (prior[:, 0] <= 0.05)))
        self.assertTrue(torch.all((prior[:, 1] >= 0) & (prior[:, 1] <= 0.5)))

    def test_multiphysics_candidate_is_neutral_migration_and_exposes_states(self):
        dataset = generate_dimensionless_spm_dataset(
            8,
            time_steps=16,
            radial_points=8,
            seed=92,
        )
        base_config = SPMPINOTransformerConfig(
            model_dim=16,
            attention_heads=4,
            transformer_layers=1,
            operator_width=8,
            operator_layers=1,
            radial_modes=3,
            dropout=0.0,
            soc_head_version=4,
            temperature_head_version=1,
            operator_residual_version=1,
            health_conditioned_version=2,
            router_feature_version=2,
        )
        torch.manual_seed(11)
        base = SPMPINOTransformer(base_config).eval()
        enhanced_config = replace(
            base_config,
            multiphysics_version=1,
            thermal_operator_version=1,
            cross_physics_attention_version=1,
            degradation_head_version=1,
            thermal_operator_width=8,
            thermal_operator_layers=1,
            thermal_modes=3,
        )
        enhanced = SPMPINOTransformer(enhanced_config).eval()
        incompatible = enhanced.load_state_dict(base.state_dict(), strict=False)
        self.assertFalse(incompatible.unexpected_keys)
        self.assertTrue(
            all(
                key.startswith(
                    (
                        "electrochemical_token.",
                        "thermal_token.",
                        "degradation_token.",
                        "cross_physics_attention.",
                        "thermal_parameter_head.",
                        "thermal_operator_",
                        "temperature_feedback_gate",
                        "concentration_coupling_head.",
                        "degradation_head.",
                    )
                )
                for key in incompatible.missing_keys
            )
        )
        args = dataset.tensors()[:7]
        kwargs = {
            "initial_soc": dataset.initial_soc,
            "duration_hours": dataset.duration_hours,
            "capacity_ratio": dataset.capacity_ratio,
            "route_mode": "both",
        }
        with torch.no_grad():
            base_output = base(*args, **kwargs)
            enhanced_output = enhanced(*args, **kwargs)
        self.assertTrue(
            torch.allclose(
                enhanced_output.concentration,
                base_output.concentration,
                atol=1e-7,
            )
        )
        self.assertTrue(
            torch.allclose(
                enhanced_output.voltage_v,
                base_output.voltage_v,
                atol=1e-7,
            )
        )
        self.assertTrue(
            torch.allclose(enhanced_output.soc, base_output.soc, atol=1e-7)
        )
        self.assertTrue(
            torch.allclose(
                enhanced_output.temperature_c,
                base_output.temperature_c,
                atol=1e-7,
            )
        )
        self.assertEqual(
            enhanced_output.effective_diffusivity.shape,
            (8, 16, 2),
        )
        self.assertEqual(enhanced_output.degradation_state.shape, (8, 16, 2))
        self.assertEqual(
            enhanced_output.physics_attention_weights.shape,
            (8, 16, 3, 3),
        )
        increments = (
            enhanced_output.degradation_state[:, 1:]
            - enhanced_output.degradation_state[:, :-1]
        )
        self.assertTrue(torch.all(increments >= -1e-8))
        trainable = freeze_v10_backbone_for_multiphysics(enhanced)
        self.assertTrue(trainable)
        self.assertFalse(enhanced.fast_head[-1].weight.requires_grad)
        self.assertFalse(enhanced.router.network[-1].weight.requires_grad)
        self.assertTrue(enhanced.temperature_feedback_gate.requires_grad)


if __name__ == "__main__":
    unittest.main()
