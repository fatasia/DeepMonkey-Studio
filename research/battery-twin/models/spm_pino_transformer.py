"""Transformer-conditioned spectral SPM operator with two-stage routing.

Research candidate only.  The model is deliberately not imported by any
production adapter.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace

import torch
from torch import Tensor, nn

from research.multiphysics_physics import arrhenius_diffusivity
from research.spm_physics import radial_grid, radial_volume_average, spm_residuals
from research.transfer_learning import (
    FewShotTransferAdapter,
    ProtocolContextEncoder,
    SupportPhysicalParameterIdentifier,
)


@dataclass(frozen=True)
class SPMPINOTransformerConfig:
    chemistry_families: int = 6
    chemistry_embedding_dim: int = 8
    model_dim: int = 48
    attention_heads: int = 4
    transformer_layers: int = 2
    operator_width: int = 32
    operator_layers: int = 3
    radial_modes: int = 8
    dropout: float = 0.05
    router_temperature: float = 1.0
    # v1 preserves compatibility with the existing advisory checkpoint.
    # v2 is the first coulomb-prior candidate. v3 bounds its correction; v4
    # fully separates that correction from the shared physical representation.
    soc_head_version: int = 1
    soc_correction_limit: float = 0.02
    temperature_head_version: int = 0
    operator_residual_version: int = 0
    # v1 is the legacy double-scaling contract (capacity both conditions the
    # representation and divides coulomb throughput). v2 keeps health as a
    # condition only because current_c_rate already uses the effective profile
    # capacity in the multifidelity dataset contract.
    health_conditioned_version: int = 0
    router_feature_version: int = 0
    sparse_physics_override_threshold: float = 1.0
    sparse_router_probability_threshold: float = 0.5
    # All multiphysics additions are opt-in so v10.6 checkpoints retain an
    # identical module graph and output path when these versions stay at zero.
    multiphysics_version: int = 0
    thermal_operator_version: int = 0
    cross_physics_attention_version: int = 0
    degradation_head_version: int = 0
    degradation_context_version: int = 0
    degradation_context_features: int = 8
    thermal_operator_width: int = 24
    thermal_operator_layers: int = 2
    thermal_modes: int = 8
    concentration_coupling_limit: float = 0.005
    # Transfer modules are opt-in so every existing checkpoint retains its
    # original graph and numerical path when these versions remain zero.
    transfer_adapter_version: int = 0
    robust_support_aggregation_version: int = 0
    transfer_support_features: int = 15
    transfer_prompt_features: int = 8
    sensor_mask_version: int = 0
    physical_identifier_version: int = 0
    physical_parameter_count: int = 8
    protocol_context_version: int = 0
    protocol_context_features: int = 12
    transfer_safe_mode_version: int = 0
    transfer_calibration_min_abs_v: float = 5e-6
    transfer_calibration_max_abs_v: float = 1e-4
    # Offline teacher distillation can add one lightweight voltage residual
    # adapter to the V13 backbone. It is zero-initialized, opt-in and replaces
    # the need to run a second full PINO expert during inference.
    domain_residual_adapter_version: int = 0
    domain_voltage_correction_limit_v: float = 1.0
    domain_temperature_correction_limit_c: float = 2.0
    domain_concentration_correction_limit: float = 0.08
    # Keep the native LFP inference path numerically aligned with the validated
    # v10.6 physical core. Extra multi-physics modules remain available for
    # transfer/OOD domains, but are not allowed to perturb the native path.
    native_v10_guard_version: int = 0
    native_v10_guard_chemistry_index: int = 0


@dataclass
class SPMPINOTransformerOutput:
    concentration: Tensor
    voltage_v: Tensor
    soc: Tensor
    route_weights: Tensor
    route_risk_features: Tensor
    fast_concentration: Tensor
    operator_concentration: Tensor
    soc_correction: Tensor
    temperature_c: Tensor
    fast_voltage_v: Tensor
    operator_voltage_v: Tensor
    effective_diffusivity: Tensor
    thermal_parameters: Tensor
    activation_k: Tensor
    degradation_state: Tensor
    degradation_prior: Tensor
    physics_attention_weights: Tensor
    transfer_adapter_strength: Tensor
    transfer_calibration: Tensor
    identified_physical_parameters: Tensor
    effective_physical_parameters: Tensor
    physical_parameter_confidence: Tensor
    protocol_context_strength: Tensor


class RadialSpectralConv1d(nn.Module):
    def __init__(self, in_channels: int, out_channels: int, modes: int) -> None:
        super().__init__()
        self.in_channels = in_channels
        self.out_channels = out_channels
        self.modes = modes
        scale = 1.0 / max(1, in_channels * out_channels)
        self.weight = nn.Parameter(
            scale
            * torch.randn(
                in_channels,
                out_channels,
                modes,
                dtype=torch.cfloat,
            )
        )

    def forward(self, values: Tensor) -> Tensor:
        if values.ndim != 3:
            raise ValueError("谱卷积输入必须为 [batch, channels, radial]。")
        spectrum = torch.fft.rfft(values, dim=-1)
        used_modes = min(self.modes, spectrum.shape[-1])
        output_spectrum = torch.zeros(
            values.shape[0],
            self.out_channels,
            spectrum.shape[-1],
            device=values.device,
            dtype=spectrum.dtype,
        )
        output_spectrum[:, :, :used_modes] = torch.einsum(
            "bim,iom->bom",
            spectrum[:, :, :used_modes],
            self.weight[:, :, :used_modes],
        )
        return torch.fft.irfft(
            output_spectrum,
            n=values.shape[-1],
            dim=-1,
        )


class RadialOperatorBlock(nn.Module):
    def __init__(self, width: int, modes: int, dropout: float) -> None:
        super().__init__()
        self.spectral = RadialSpectralConv1d(width, width, modes)
        self.local = nn.Conv1d(width, width, kernel_size=1)
        self.norm = nn.GroupNorm(1, width)
        self.dropout = nn.Dropout(dropout)

    def forward(self, values: Tensor) -> Tensor:
        update = torch.nn.functional.gelu(
            self.norm(self.spectral(values) + self.local(values))
        )
        return values + self.dropout(update)


class CrossPhysicsAttention(nn.Module):
    """Exchange information between electrochemical, thermal and ageing fields."""

    def __init__(self, model_dim: int, heads: int, dropout: float) -> None:
        super().__init__()
        self.attention = nn.MultiheadAttention(
            model_dim,
            heads,
            dropout=dropout,
            batch_first=True,
        )
        self.norm = nn.LayerNorm(model_dim)
        # One gate per physical field.  Exact zeros make the migration neutral:
        # the old v10.6 prediction is preserved before candidate training.
        self.coupling_gate = nn.Parameter(torch.zeros(3))

    def forward(self, tokens: Tensor) -> tuple[Tensor, Tensor]:
        if tokens.ndim != 4 or tokens.shape[2] != 3:
            raise ValueError("跨物理 token 必须为 [batch, time, 3, dim]。")
        batch, time_steps, fields, width = tokens.shape
        flattened = tokens.reshape(batch * time_steps, fields, width)
        update, weights = self.attention(
            flattened,
            flattened,
            flattened,
            need_weights=True,
            average_attn_weights=False,
        )
        update = self.norm(update)
        gated = update * self.coupling_gate.reshape(1, fields, 1)
        mean_weights = weights.mean(dim=1).reshape(
            batch,
            time_steps,
            fields,
            fields,
        )
        return gated.reshape(batch, time_steps, fields, width), mean_weights


class RiskAwareRouter(nn.Module):
    """Routes scenarios after observing preliminary physical residuals."""

    def __init__(self, features: int = 6, hidden: int = 24) -> None:
        super().__init__()
        self.network = nn.Sequential(
            nn.Linear(features, hidden),
            nn.GELU(),
            nn.Linear(hidden, 2),
        )
        with torch.no_grad():
            final = self.network[-1]
            assert isinstance(final, nn.Linear)
            final.bias.copy_(torch.tensor([1.0, 0.0]))

    def forward(
        self,
        risk_features: Tensor,
        *,
        temperature: float,
        hard: bool,
    ) -> Tensor:
        logits = self.network(risk_features.detach())
        soft = torch.softmax(logits / max(temperature, 1e-3), dim=-1)
        if not hard:
            return soft
        selected = torch.nn.functional.one_hot(
            soft.argmax(dim=-1),
            num_classes=2,
        ).to(soft.dtype)
        # Straight-through routing keeps training gradients if hard routing is
        # used for a research ablation.
        return selected + soft - soft.detach()


class SPMPINOTransformer(nn.Module):
    """Temporal Transformer observer + radial neural operator candidate."""

    def __init__(self, config: SPMPINOTransformerConfig | None = None) -> None:
        super().__init__()
        self.config = config or SPMPINOTransformerConfig()
        if self.config.model_dim % self.config.attention_heads:
            raise ValueError("model_dim 必须能被 attention_heads 整除。")
        self.chemistry_embedding = nn.Embedding(
            self.config.chemistry_families,
            self.config.chemistry_embedding_dim,
        )
        condition_size = self.config.chemistry_embedding_dim + (
            8 if self.config.soc_head_version >= 2 else 6
        )
        if self.config.health_conditioned_version >= 1:
            condition_size += 1
        self.temporal_input = nn.Linear(5, self.config.model_dim)
        self.condition_projection = nn.Linear(condition_size, self.config.model_dim)
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=self.config.model_dim,
            nhead=self.config.attention_heads,
            dim_feedforward=self.config.model_dim * 3,
            dropout=self.config.dropout,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        self.temporal_encoder = nn.TransformerEncoder(
            encoder_layer,
            num_layers=self.config.transformer_layers,
        )
        decoder_features = self.config.model_dim + 3
        self.fast_head = nn.Sequential(
            nn.Linear(decoder_features, self.config.operator_width),
            nn.GELU(),
            nn.Linear(self.config.operator_width, 2),
        )
        self.operator_input = nn.Conv1d(
            decoder_features,
            self.config.operator_width,
            kernel_size=1,
        )
        self.operator_blocks = nn.ModuleList(
            RadialOperatorBlock(
                self.config.operator_width,
                self.config.radial_modes,
                self.config.dropout,
            )
            for _ in range(self.config.operator_layers)
        )
        self.operator_output = nn.Conv1d(
            self.config.operator_width,
            2,
            kernel_size=1,
        )
        router_features = 15 if self.config.router_feature_version >= 2 else 6
        router_hidden = 48 if self.config.router_feature_version >= 2 else 24
        self.router = RiskAwareRouter(router_features, router_hidden)
        voltage_features = self.config.model_dim + 6
        self.voltage_head = nn.Sequential(
            nn.Linear(voltage_features, 48),
            nn.GELU(),
            nn.Linear(48, 1),
        )
        if self.config.soc_head_version >= 2:
            if self.config.soc_head_version >= 4:
                soc_features = 6
            elif self.config.soc_head_version >= 3:
                soc_features = self.config.model_dim + 3
            else:
                soc_features = voltage_features
            self.soc_correction_head = nn.Sequential(
                nn.Linear(soc_features, 48),
                nn.GELU(),
                nn.Linear(48, 1),
            )
            if self.config.soc_head_version >= 4:
                # v4 is a bounded residual around exact coulomb integration.
                # Starting from zero preserves that physical solution; measured
                # deviations can still move the residual during training.
                nn.init.zeros_(self.soc_correction_head[-1].weight)
                nn.init.zeros_(self.soc_correction_head[-1].bias)
        if self.config.temperature_head_version >= 1:
            self.temperature_head = nn.Sequential(
                nn.Linear(self.config.model_dim + 2, 48),
                nn.GELU(),
                nn.Linear(48, 1),
            )
            # The thermal head predicts a residual relative to the measured
            # initial temperature.  A zero final layer is the physically
            # neutral starting point and avoids adding a spurious temperature
            # drift before the electrothermal signal is learned.
            nn.init.zeros_(self.temperature_head[-1].weight)
            nn.init.zeros_(self.temperature_head[-1].bias)
        if self.config.cross_physics_attention_version >= 1:
            self.electrochemical_token = nn.Linear(7, self.config.model_dim)
            self.thermal_token = nn.Linear(4, self.config.model_dim)
            self.degradation_token = nn.Linear(5, self.config.model_dim)
            self.cross_physics_attention = CrossPhysicsAttention(
                self.config.model_dim,
                self.config.attention_heads,
                self.config.dropout,
            )
        if self.config.thermal_operator_version >= 1:
            thermal_features = self.config.model_dim + 5
            self.thermal_parameter_head = nn.Sequential(
                nn.Linear(self.config.model_dim, 32),
                nn.GELU(),
                nn.Linear(32, 5),
            )
            self.thermal_operator_input = nn.Conv1d(
                thermal_features,
                self.config.thermal_operator_width,
                kernel_size=1,
            )
            self.thermal_operator_blocks = nn.ModuleList(
                RadialOperatorBlock(
                    self.config.thermal_operator_width,
                    self.config.thermal_modes,
                    self.config.dropout,
                )
                for _ in range(self.config.thermal_operator_layers)
            )
            self.thermal_operator_output = nn.Conv1d(
                self.config.thermal_operator_width,
                1,
                kernel_size=1,
            )
            nn.init.zeros_(self.thermal_operator_output.weight)
            nn.init.zeros_(self.thermal_operator_output.bias)
        if self.config.multiphysics_version >= 1:
            self.temperature_feedback_gate = nn.Parameter(torch.zeros(()))
            self.concentration_coupling_head = nn.Sequential(
                nn.Linear(self.config.model_dim + 6, 32),
                nn.GELU(),
                nn.Linear(32, 2),
            )
            nn.init.zeros_(self.concentration_coupling_head[-1].weight)
            nn.init.zeros_(self.concentration_coupling_head[-1].bias)
        if self.config.degradation_head_version >= 1:
            self.degradation_head = nn.Sequential(
                nn.Linear(self.config.model_dim + 5, 32),
                nn.GELU(),
                nn.Linear(32, 2),
            )
            nn.init.zeros_(self.degradation_head[-1].weight)
            nn.init.constant_(self.degradation_head[-1].bias, -8.0)
        if self.config.degradation_context_version >= 1:
            self.degradation_context_encoder = nn.Sequential(
                nn.Linear(
                    self.config.degradation_context_features,
                    self.config.model_dim,
                ),
                nn.GELU(),
                nn.Linear(self.config.model_dim, self.config.model_dim),
            )
            self.degradation_prior_head = nn.Sequential(
                nn.Linear(self.config.model_dim, 32),
                nn.GELU(),
                nn.Linear(32, 2),
            )
            self.degradation_context_gate = nn.Parameter(torch.zeros(()))
        if self.config.transfer_adapter_version >= 1:
            self.transfer_adapter = FewShotTransferAdapter(
                support_features=self.config.transfer_support_features,
                prompt_features=self.config.transfer_prompt_features,
                model_dim=self.config.model_dim,
                dropout=self.config.dropout,
                robust_support=(
                    self.config.robust_support_aggregation_version >= 1
                ),
            )
        if self.config.domain_residual_adapter_version >= 1:
            self.domain_voltage_residual_adapter = nn.Sequential(
                nn.Linear(self.config.model_dim + 4, 32),
                nn.GELU(),
                nn.Linear(32, 1),
            )
            nn.init.zeros_(
                self.domain_voltage_residual_adapter[-1].weight
            )
            nn.init.zeros_(
                self.domain_voltage_residual_adapter[-1].bias
            )
        if self.config.domain_residual_adapter_version >= 2:
            # One learned scalar per declared chemistry/domain keeps the
            # distilled residual inside the domain that supplied its teacher.
            # Unseen rows stay exactly zero, so a Farasis specialist cannot
            # silently alter an LG M50T or native-LFP prediction.
            self.domain_residual_gate = nn.Embedding(
                self.config.chemistry_families,
                1,
            )
            nn.init.zeros_(self.domain_residual_gate.weight)
        if self.config.domain_residual_adapter_version >= 3:
            self.domain_multiphysics_gate = nn.Embedding(
                self.config.chemistry_families,
                1,
            )
            self.domain_temperature_residual_adapter = nn.Sequential(
                nn.Linear(self.config.model_dim + 4, 32),
                nn.GELU(),
                nn.Linear(32, 1),
            )
            self.domain_concentration_residual_adapter = nn.Sequential(
                nn.Linear(self.config.model_dim + 5, 32),
                nn.GELU(),
                nn.Linear(32, 2),
            )
            nn.init.zeros_(self.domain_multiphysics_gate.weight)
            nn.init.zeros_(
                self.domain_temperature_residual_adapter[-1].weight
            )
            nn.init.zeros_(
                self.domain_temperature_residual_adapter[-1].bias
            )
            nn.init.zeros_(
                self.domain_concentration_residual_adapter[-1].weight
            )
            nn.init.zeros_(
                self.domain_concentration_residual_adapter[-1].bias
            )
        if self.config.physical_identifier_version >= 1:
            self.physical_parameter_identifier = (
                SupportPhysicalParameterIdentifier(
                    support_features=self.config.transfer_support_features,
                    model_dim=self.config.model_dim,
                    parameter_count=self.config.physical_parameter_count,
                    prompt_features=(
                        self.config.transfer_prompt_features
                        if self.config.physical_identifier_version >= 2
                        else 0
                    ),
                )
            )
        if self.config.protocol_context_version >= 1:
            self.protocol_context_encoder = ProtocolContextEncoder(
                context_features=self.config.protocol_context_features,
                model_dim=self.config.model_dim,
                dropout=self.config.dropout,
            )
        if self.config.sensor_mask_version >= 1:
            self.sensor_mask_projection = nn.Linear(
                2,
                self.config.model_dim,
                bias=False,
            )
            # A newly attached sensor-mask branch is a neutral migration.
            nn.init.zeros_(self.sensor_mask_projection.weight)

    def encode_degradation_context(
        self,
        degradation_context: Tensor,
    ) -> tuple[Tensor, Tensor]:
        """Encode support diagnostics into a transferable degradation prior."""

        if self.config.degradation_context_version < 1:
            raise RuntimeError("当前模型未启用退化上下文编码器。")
        if (
            degradation_context.ndim != 2
            or degradation_context.shape[1]
            != self.config.degradation_context_features
        ):
            raise ValueError(
                "degradation_context 必须为 "
                f"[batch, {self.config.degradation_context_features}]。"
            )
        embedding = self.degradation_context_encoder(degradation_context)
        raw_prior = self.degradation_prior_head(embedding)
        # The public pretraining task predicts the *increment* from the most
        # recent diagnostic, not an absolute state.  This preserves the strong
        # last-observation baseline and prevents capacity-target leakage.
        prior = torch.stack(
            (
                0.05 * torch.sigmoid(raw_prior[:, 0]),
                0.50 * torch.sigmoid(raw_prior[:, 1]),
            ),
            dim=-1,
        )
        return embedding, prior

    def _temporal_context(
        self,
        current_c_rate: Tensor,
        temperature_c: Tensor,
        delta_time: Tensor,
        initial_concentration: Tensor,
        diffusivity: Tensor,
        surface_flux_scale: Tensor,
        chemistry_index: Tensor,
        initial_soc: Tensor | None,
        duration_hours: Tensor | None,
        capacity_ratio: Tensor | None,
        sensor_mask: Tensor | None,
        *,
        apply_sensor_mask: bool = True,
    ) -> Tensor:
        batch, time_steps = current_c_rate.shape
        cumulative_time = delta_time.cumsum(dim=1)
        duration = cumulative_time[:, -1:].clamp_min(1e-6)
        normalized_time = cumulative_time / duration
        ramp = torch.zeros_like(current_c_rate)
        ramp[:, 1:] = (
            current_c_rate[:, 1:] - current_c_rate[:, :-1]
        ) / delta_time[:, 1:].clamp_min(1e-6)
        features = torch.stack(
            (
                current_c_rate,
                (temperature_c - 25.0) / 20.0,
                normalized_time,
                torch.sin(2.0 * torch.pi * normalized_time),
                torch.tanh(ramp / 10.0),
            ),
            dim=-1,
        )
        chemistry = self.chemistry_embedding(chemistry_index.long())
        condition_items = [
            chemistry,
            initial_concentration,
            diffusivity,
            surface_flux_scale,
        ]
        if self.config.soc_head_version >= 2:
            if initial_soc is None or duration_hours is None:
                raise ValueError(
                    "SOC Head v2 需要 initial_soc 和 duration_hours。"
                )
            condition_items.extend(
                (
                    initial_soc.reshape(batch, 1),
                    (duration_hours.reshape(batch, 1) / 0.10).clamp(0.0, 4.0),
                )
            )
        if self.config.health_conditioned_version >= 1:
            if capacity_ratio is None:
                raise ValueError("v5 健康条件模型需要 capacity_ratio。")
            condition_items.append(capacity_ratio.reshape(batch, 1))
        condition = torch.cat(condition_items, dim=-1)
        temporal_input = self.temporal_input(features)
        if self.config.sensor_mask_version >= 1 and apply_sensor_mask:
            if sensor_mask is None:
                sensor_mask = torch.ones(
                    batch,
                    time_steps,
                    2,
                    dtype=temporal_input.dtype,
                    device=temporal_input.device,
                )
            if sensor_mask.shape != (batch, time_steps, 2):
                raise ValueError(
                    "sensor_mask 必须为 [batch, time, 2]，"
                    "通道顺序为 current、temperature。"
                )
            temporal_input = temporal_input + self.sensor_mask_projection(
                sensor_mask.to(temporal_input.dtype) - 1.0
            )
        return self.temporal_encoder(
            temporal_input
            + self.condition_projection(condition).unsqueeze(1).expand(
                batch,
                time_steps,
                self.config.model_dim,
            )
        )

    def _risk_summary(
        self,
        concentration: Tensor,
        current_c_rate: Tensor,
        temperature_c: Tensor,
        delta_time: Tensor,
        diffusivity: Tensor,
        surface_flux_scale: Tensor,
        initial_soc: Tensor | None = None,
        duration_hours: Tensor | None = None,
    ) -> Tensor:
        residual = spm_residuals(
            concentration,
            current_c_rate,
            delta_time,
            diffusivity,
            flux_scale=surface_flux_scale,
        )

        def rms(values: Tensor) -> Tensor:
            return values.pow(2).flatten(1).mean(dim=1).sqrt()

        ramp = (
            current_c_rate[:, 1:] - current_c_rate[:, :-1]
        ).abs().mean(dim=1)
        temperature_risk = (temperature_c - 25.0).abs().mean(dim=1) / 20.0
        base = torch.stack(
            (
                rms(residual.dynamics),
                rms(residual.surface_boundary),
                rms(residual.conservation),
                ramp,
                temperature_risk,
                current_c_rate.abs().amax(dim=1),
            ),
            dim=-1,
        )
        if self.config.router_feature_version < 2:
            return base

        batch = current_c_rate.shape[0]
        initial_soc_feature = (
            initial_soc.reshape(batch)
            if initial_soc is not None
            else torch.zeros(batch, device=current_c_rate.device, dtype=current_c_rate.dtype)
        )
        duration_feature = (
            duration_hours.reshape(batch) / 0.5
            if duration_hours is not None
            else torch.zeros(batch, device=current_c_rate.device, dtype=current_c_rate.dtype)
        )
        # All additions are available before the heavy expert executes. Log
        # transforms keep the physical parameter groups on an O(1) scale.
        extra = torch.stack(
            (
                rms(residual.center_boundary),
                current_c_rate.square().mean(dim=1).sqrt(),
                current_c_rate.mean(dim=1),
                duration_feature,
                initial_soc_feature,
                torch.log10(diffusivity[:, 0].clamp_min(1e-8)) / 2.0,
                torch.log10(diffusivity[:, 1].clamp_min(1e-8)) / 2.0,
                torch.log10(surface_flux_scale[:, 0].clamp_min(1e-8)) + 2.0,
                torch.log10(surface_flux_scale[:, 1].clamp_min(1e-8)) + 2.0,
            ),
            dim=-1,
        )
        return torch.cat((base, extra), dim=-1)

    def upgrade_router(self, feature_version: int) -> None:
        """Replace only the router while preserving both frozen experts."""
        if feature_version < 0:
            raise ValueError("router feature version 不能为负数。")
        self.config = replace(
            self.config,
            router_feature_version=int(feature_version),
        )
        features = 15 if feature_version >= 2 else 6
        hidden = 48 if feature_version >= 2 else 24
        reference = next(self.parameters())
        self.router = RiskAwareRouter(features, hidden).to(
            device=reference.device,
            dtype=reference.dtype,
        )

    def set_sparse_override_threshold(self, threshold: float) -> None:
        if threshold <= 0:
            raise ValueError("稀疏物理覆盖阈值必须大于零。")
        self.config = replace(
            self.config,
            sparse_physics_override_threshold=float(threshold),
        )

    def set_sparse_router_probability_threshold(self, threshold: float) -> None:
        if not 0.5 <= threshold < 1.0:
            raise ValueError("稀疏路由概率阈值必须位于 [0.5, 1.0)。")
        self.config = replace(
            self.config,
            sparse_router_probability_threshold=float(threshold),
        )

    def forward(
        self,
        current_c_rate: Tensor,
        temperature_c: Tensor,
        delta_time: Tensor,
        initial_concentration: Tensor,
        diffusivity: Tensor,
        surface_flux_scale: Tensor,
        chemistry_index: Tensor,
        initial_soc: Tensor | None = None,
        duration_hours: Tensor | None = None,
        capacity_ratio: Tensor | None = None,
        degradation_context: Tensor | None = None,
        transfer_support: Tensor | None = None,
        transfer_support_mask: Tensor | None = None,
        physical_prompt: Tensor | None = None,
        protocol_context: Tensor | None = None,
        sensor_mask: Tensor | None = None,
        validated_native_domain: bool | Tensor = False,
        *,
        hard_route: bool = False,
        route_mode: str = "dynamic",
    ) -> SPMPINOTransformerOutput:
        if current_c_rate.ndim != 2:
            raise ValueError("current_c_rate 必须为 [batch, time]。")
        if temperature_c.shape != current_c_rate.shape or delta_time.shape != current_c_rate.shape:
            raise ValueError("temperature_c 和 delta_time 必须与 current_c_rate 同形。")
        batch, time_steps = current_c_rate.shape
        if (
            initial_concentration.shape != (batch, 2)
            or diffusivity.shape != (batch, 2)
            or surface_flux_scale.shape != (batch, 2)
        ):
            raise ValueError(
                "initial_concentration、diffusivity 和 surface_flux_scale "
                "必须为 [batch, 2]。"
            )
        native_domain_is_validated = (
            bool(validated_native_domain.all())
            if isinstance(validated_native_domain, Tensor)
            else bool(validated_native_domain)
        )
        native_v10_guard = (
            self.config.native_v10_guard_version >= 1
            and native_domain_is_validated
            and bool(
                (
                    chemistry_index
                    == self.config.native_v10_guard_chemistry_index
                ).all()
            )
            and transfer_support is None
            and physical_prompt is None
        )

        temporal = self._temporal_context(
            current_c_rate,
            temperature_c,
            delta_time,
            initial_concentration,
            diffusivity,
            surface_flux_scale,
            chemistry_index,
            initial_soc,
            duration_hours,
            capacity_ratio,
            sensor_mask,
            apply_sensor_mask=not native_v10_guard,
        )
        transfer_adapter_strength = temporal.new_zeros(())
        if (
            self.config.transfer_adapter_version >= 1
            and not native_v10_guard
        ):
            original_temporal = temporal
            (
                temporal,
                transfer_adapter_strength,
                transfer_calibration,
            ) = self.transfer_adapter(
                temporal,
                transfer_support,
                transfer_support_mask,
                physical_prompt,
            )
            if self.config.transfer_safe_mode_version >= 1:
                # Validated safe path: support residual calibration is kept,
                # while FiLM remains a diagnostic ablation only.
                temporal = original_temporal
            if (
                self.config.transfer_safe_mode_version >= 2
                and transfer_support is not None
                and transfer_support_mask is not None
            ):
                weights = transfer_support_mask.to(temporal.dtype)
                voltage_residual = transfer_support[:, :, -3]
                mean_residual = (
                    voltage_residual * weights
                ).sum(dim=1) / weights.sum(dim=1).clamp_min(1.0)
                mean_absolute = (
                    voltage_residual.abs() * weights
                ).sum(dim=1) / weights.sum(dim=1).clamp_min(1.0)
                sign_consistency = (
                    mean_residual.abs()
                    / mean_absolute.clamp_min(1e-4)
                ).clamp(0.0, 1.0)
                transfer_calibration = (
                    transfer_calibration * sign_consistency[:, None]
                )
            if self.config.transfer_safe_mode_version >= 3:
                magnitude = transfer_calibration[:, 0].abs()
                trusted = (
                    (magnitude >= self.config.transfer_calibration_min_abs_v)
                    & (
                        magnitude
                        <= self.config.transfer_calibration_max_abs_v
                    )
                ).to(transfer_calibration.dtype)
                transfer_calibration = (
                    transfer_calibration * trusted[:, None]
                )
        else:
            transfer_calibration = temporal.new_zeros(batch, 3)
        identified_physical_parameters = temporal.new_zeros(
            batch, self.config.physical_parameter_count
        )
        effective_physical_parameters = temporal.new_zeros(
            batch, self.config.physical_parameter_count
        )
        physical_parameter_confidence = temporal.new_zeros(
            batch, self.config.physical_parameter_count
        )
        if (
            self.config.physical_identifier_version >= 1
            and not native_v10_guard
        ):
            (
                identified_physical_parameters,
                effective_physical_parameters,
                physical_parameter_confidence,
            ) = self.physical_parameter_identifier(
                transfer_support,
                transfer_support_mask,
                reference=temporal,
                physical_prompt=physical_prompt,
                anchor_capacity=(
                    self.config.physical_identifier_version >= 2
                ),
            )
        protocol_context_strength = temporal.new_zeros(())
        if (
            self.config.protocol_context_version >= 1
            and protocol_context is not None
            and not native_v10_guard
        ):
            protocol_residual, protocol_context_strength = (
                self.protocol_context_encoder(
                    protocol_context,
                    time_steps=time_steps,
                )
            )
            temporal = temporal + protocol_residual
        degradation_context_embedding = temporal.new_zeros(
            batch,
            self.config.model_dim,
        )
        degradation_prior = temporal.new_zeros(batch, 2)
        degradation_context_strength = temporal.new_zeros(())
        if (
            self.config.degradation_context_version >= 1
            and degradation_context is not None
            and not native_v10_guard
        ):
            (
                degradation_context_embedding,
                degradation_prior,
            ) = self.encode_degradation_context(degradation_context)
            degradation_context_strength = torch.sigmoid(
                self.degradation_context_gate
            )
        radial_points = max(4, getattr(self, "_requested_radial_points", 24))
        _, centers, _ = radial_grid(
            radial_points,
            device=current_c_rate.device,
            dtype=current_c_rate.dtype,
        )
        radial_features = torch.stack(
            (
                centers,
                torch.sin(torch.pi * centers),
                torch.cos(torch.pi * centers),
            ),
            dim=-1,
        )
        grid = torch.cat(
            (
                temporal[:, :, None, :].expand(
                    batch,
                    time_steps,
                    radial_points,
                    self.config.model_dim,
                ),
                radial_features[None, None, :, :].expand(
                    batch,
                    time_steps,
                    radial_points,
                    3,
                ),
            ),
            dim=-1,
        )
        fast_logits = self.fast_head(grid)
        fast_concentration = torch.sigmoid(fast_logits)

        fast_risk = self._risk_summary(
            fast_concentration,
            current_c_rate,
            temperature_c,
            delta_time,
            diffusivity,
            surface_flux_scale,
            initial_soc,
            duration_hours,
        )
        learned_route_weights = self.router(
            fast_risk,
            temperature=self.config.router_temperature,
            hard=hard_route,
        )

        def run_operator(
            selected_grid: Tensor,
            selected_fast: Tensor,
        ) -> Tensor:
            selected_batch = selected_grid.shape[0]
            operator_values = self.operator_input(
                selected_grid.reshape(
                    selected_batch * time_steps,
                    radial_points,
                    -1,
                ).transpose(1, 2)
            )
            for block in self.operator_blocks:
                operator_values = block(operator_values)
            operator_logits = self.operator_output(operator_values).transpose(1, 2)
            operator_logits = operator_logits.reshape(
                selected_batch,
                time_steps,
                radial_points,
                2,
            )
            if self.config.operator_residual_version >= 1:
                # v5 starts from the trained standard expert and lets the
                # neural operator learn only a bounded physics correction.
                return (
                    selected_fast
                    + 0.01 * torch.tanh(operator_logits)
                ).clamp(0.001, 0.999)
            return torch.sigmoid(operator_logits)

        if route_mode == "dynamic_sparse":
            # True conditional execution: the cheap expert is evaluated first.
            # Only samples with a high preliminary physics/domain risk execute
            # the spectral operator. Extreme OOD fallback is handled by the
            # digital-twin runtime before this model is called.
            risk_score = torch.stack(
                (
                    fast_risk[:, 0] / 0.15,
                    fast_risk[:, 1] / 0.08,
                    fast_risk[:, 2] / 0.08,
                    fast_risk[:, 3] / 0.80,
                    fast_risk[:, 4] / 0.75,
                    fast_risk[:, 5] / 1.20,
                ),
                dim=-1,
            ).amax(dim=-1)
            high_risk = (
                risk_score >= self.config.sparse_physics_override_threshold
            ) | (
                learned_route_weights[:, 1]
                >= self.config.sparse_router_probability_threshold
            )
            operator_concentration = fast_concentration.clone()
            if bool(high_risk.any()):
                operator_concentration[high_risk] = run_operator(
                    grid[high_risk],
                    fast_concentration[high_risk],
                )
            route_weights = torch.nn.functional.one_hot(
                high_risk.long(),
                num_classes=2,
            ).to(fast_concentration.dtype)
        elif route_mode == "fast":
            # True light-expert short circuit for latency-sensitive inference.
            operator_concentration = fast_concentration
        else:
            # Training and explicit dual-expert comparison require the heavy
            # expert for every sample.
            operator_concentration = run_operator(grid, fast_concentration)

        if route_mode == "both":
            route_weights = torch.full_like(learned_route_weights, 0.5)
        elif route_mode == "fast":
            route_weights = torch.zeros_like(learned_route_weights)
            route_weights[:, 0] = 1.0
        elif route_mode == "operator":
            route_weights = torch.zeros_like(learned_route_weights)
            route_weights[:, 1] = 1.0
        elif route_mode == "dynamic":
            route_weights = learned_route_weights
        elif route_mode == "dynamic_sparse":
            pass
        else:
            raise ValueError(
                "route_mode 必须为 both、dynamic、dynamic_sparse、fast 或 operator。"
            )
        concentration = (
            route_weights[:, 0, None, None, None] * fast_concentration
            + route_weights[:, 1, None, None, None] * operator_concentration
        )
        def voltage_from(
            candidate: Tensor,
            temporal_signal: Tensor = temporal,
            temperature_signal: Tensor = temperature_c,
        ) -> tuple[Tensor, Tensor]:
            candidate_average = radial_volume_average(candidate)
            candidate_surface = candidate[:, :, -1, :]
            candidate_input = torch.cat(
                (
                    temporal_signal,
                    candidate_surface,
                    candidate_average,
                    current_c_rate.unsqueeze(-1),
                    ((temperature_signal - 25.0) / 20.0).unsqueeze(-1),
                ),
                dim=-1,
            )
            candidate_voltage = 2.5 + 2.0 * torch.sigmoid(
                self.voltage_head(candidate_input).squeeze(-1)
            )
            return candidate_voltage, candidate_input

        fast_voltage_v, _ = voltage_from(fast_concentration)
        operator_voltage_v, _ = voltage_from(operator_concentration)
        preliminary_voltage_v, voltage_input = voltage_from(concentration)
        average = radial_volume_average(concentration)
        cumulative_throughput = torch.cumsum(
            current_c_rate.abs() * delta_time,
            dim=1,
        )
        physics_context = temporal.new_zeros(
            batch,
            time_steps,
            3,
            self.config.model_dim,
        )
        physics_attention_weights = temporal.new_zeros(
            batch,
            time_steps,
            3,
            3,
        )
        if (
            self.config.cross_physics_attention_version >= 1
            and not native_v10_guard
        ):
            capacity_condition = (
                capacity_ratio.reshape(batch, 1).expand(batch, time_steps)
                if capacity_ratio is not None
                else torch.ones_like(current_c_rate)
            )
            initial_soc_condition = (
                initial_soc.reshape(batch, 1).expand(batch, time_steps)
                if initial_soc is not None
                else torch.full_like(current_c_rate, 0.5)
            )
            electrochemical_features = torch.cat(
                (
                    concentration[:, :, -1, :],
                    average,
                    preliminary_voltage_v.unsqueeze(-1),
                    current_c_rate.unsqueeze(-1),
                    ((temperature_c - 25.0) / 20.0).unsqueeze(-1),
                ),
                dim=-1,
            )
            thermal_features = torch.stack(
                (
                    (temperature_c - 25.0) / 20.0,
                    current_c_rate.square(),
                    current_c_rate.abs(),
                    delta_time,
                ),
                dim=-1,
            )
            degradation_features = torch.stack(
                (
                    cumulative_throughput,
                    capacity_condition,
                    initial_soc_condition,
                    (temperature_c - 25.0).abs() / 20.0,
                    current_c_rate.abs(),
                ),
                dim=-1,
            )
            degradation_token = self.degradation_token(
                degradation_features
            ) + (
                degradation_context_strength
                * degradation_context_embedding[:, None, :]
            )
            physics_tokens = torch.stack(
                (
                    self.electrochemical_token(electrochemical_features),
                    self.thermal_token(thermal_features),
                    degradation_token,
                ),
                dim=2,
            )
            physics_context, physics_attention_weights = (
                self.cross_physics_attention(physics_tokens)
            )
        electrochemical_temporal = temporal + physics_context[:, :, 0, :]
        thermal_temporal = temporal + physics_context[:, :, 1, :]
        degradation_temporal = temporal + physics_context[:, :, 2, :]

        if self.config.temperature_head_version >= 1:
            legacy_temperature_features = torch.cat(
                (
                    temporal,
                    current_c_rate.square().unsqueeze(-1),
                    delta_time.unsqueeze(-1),
                ),
                dim=-1,
            )
            legacy_raw_temperature = self.temperature_head(
                legacy_temperature_features
            ).squeeze(-1)
            legacy_temperature_prediction = (
                temperature_c[:, :1]
                + 12.0
                * torch.tanh(
                    legacy_raw_temperature - legacy_raw_temperature[:, :1]
                )
            )
        else:
            legacy_temperature_prediction = temperature_c

        thermal_parameters = temporal.new_zeros(batch, 3)
        activation_k = temporal.new_zeros(batch, 2)
        if (
            self.config.thermal_operator_version >= 1
            and not native_v10_guard
        ):
            raw_parameters = self.thermal_parameter_head(
                thermal_temporal.mean(dim=1)
            )
            thermal_parameters = torch.stack(
                (
                    0.75 * torch.sigmoid(raw_parameters[:, 0]),
                    0.25 * torch.tanh(raw_parameters[:, 1]),
                    2.00 * torch.sigmoid(raw_parameters[:, 2]),
                ),
                dim=-1,
            )
            activation_k = 1500.0 + 6500.0 * torch.sigmoid(
                raw_parameters[:, 3:5]
            )
            thermal_features = torch.cat(
                (
                    thermal_temporal,
                    current_c_rate.square().unsqueeze(-1),
                    current_c_rate.abs().unsqueeze(-1),
                    ((temperature_c - 25.0) / 20.0).unsqueeze(-1),
                    ((preliminary_voltage_v - 3.4) / 0.8).unsqueeze(-1),
                    delta_time.unsqueeze(-1),
                ),
                dim=-1,
            )
            thermal_values = self.thermal_operator_input(
                thermal_features.transpose(1, 2)
            )
            for block in self.thermal_operator_blocks:
                thermal_values = block(thermal_values)
            heating_rate = self.thermal_operator_output(
                thermal_values
            ).squeeze(1)
            integrated_heating = torch.cumsum(
                heating_rate * delta_time,
                dim=1,
            )
            integrated_heating = (
                integrated_heating - integrated_heating[:, :1]
            )
            temperature_c_prediction = (
                legacy_temperature_prediction
                + 12.0 * torch.tanh(integrated_heating)
            )
        else:
            temperature_c_prediction = legacy_temperature_prediction
        if self.config.multiphysics_version >= 1 and not native_v10_guard:
            feedback_strength = torch.tanh(self.temperature_feedback_gate)
            electrochemical_temperature = (
                temperature_c
                + feedback_strength
                * (temperature_c_prediction - temperature_c)
            )
        else:
            electrochemical_temperature = temperature_c
        if (
            self.config.thermal_operator_version >= 1
            and not native_v10_guard
        ):
            effective_diffusivity = arrhenius_diffusivity(
                diffusivity,
                electrochemical_temperature,
                activation_k,
            )
        else:
            effective_diffusivity = diffusivity[:, None, :].expand(
                batch,
                time_steps,
                2,
            )
        if self.config.multiphysics_version >= 1 and not native_v10_guard:
            diffusivity_ratio = torch.log(
                (
                    effective_diffusivity
                    / diffusivity[:, None, :].clamp_min(1e-8)
                ).clamp_min(1e-8)
            )
            coupling_features = torch.cat(
                (
                    electrochemical_temporal[:, :, None, :].expand(
                        batch,
                        time_steps,
                        radial_points,
                        self.config.model_dim,
                    ),
                    radial_features[None, None, :, :].expand(
                        batch,
                        time_steps,
                        radial_points,
                        3,
                    ),
                    (
                        (electrochemical_temperature - temperature_c)
                        / 20.0
                    )[:, :, None, None].expand(
                        batch,
                        time_steps,
                        radial_points,
                        1,
                    ),
                    diffusivity_ratio[:, :, None, :].expand(
                        batch,
                        time_steps,
                        radial_points,
                        2,
                    ),
                ),
                dim=-1,
            )
            concentration_correction = (
                self.config.concentration_coupling_limit
                * torch.tanh(self.concentration_coupling_head(coupling_features))
            )
            concentration_correction = (
                concentration_correction - concentration_correction[:, :1]
            )
            concentration = (
                concentration + concentration_correction
            ).clamp(0.001, 0.999)
            average = radial_volume_average(concentration)
        if (
            self.config.domain_residual_adapter_version >= 3
            and not native_v10_guard
        ):
            capacity_signal = (
                capacity_ratio.reshape(batch, 1).expand(batch, time_steps)
                if capacity_ratio is not None
                else torch.ones_like(current_c_rate)
            )
            initial_soc_signal = (
                initial_soc.reshape(batch, 1).expand(batch, time_steps)
                if initial_soc is not None
                else torch.full_like(current_c_rate, 0.5)
            )
            multiphysics_domain_features = torch.cat(
                (
                    electrochemical_temporal,
                    current_c_rate.unsqueeze(-1),
                    (
                        (electrochemical_temperature - 25.0) / 20.0
                    ).unsqueeze(-1),
                    capacity_signal.unsqueeze(-1),
                    initial_soc_signal.unsqueeze(-1),
                ),
                dim=-1,
            )
            multiphysics_gate = torch.tanh(
                self.domain_multiphysics_gate(
                    chemistry_index
                ).squeeze(-1)
            ).reshape(batch, 1)
            temperature_correction = (
                self.config.domain_temperature_correction_limit_c
                * torch.tanh(
                    self.domain_temperature_residual_adapter(
                        multiphysics_domain_features
                    ).squeeze(-1)
                )
                * multiphysics_gate
            )
            temperature_correction = (
                temperature_correction - temperature_correction[:, :1]
            )
            electrochemical_temperature = (
                electrochemical_temperature + temperature_correction
            )
            concentration_features = torch.cat(
                (
                    electrochemical_temporal[:, :, None, :].expand(
                        batch,
                        time_steps,
                        radial_points,
                        self.config.model_dim,
                    ),
                    radial_features[None, None, :, :].expand(
                        batch,
                        time_steps,
                        radial_points,
                        3,
                    ),
                    current_c_rate[:, :, None, None].expand(
                        batch,
                        time_steps,
                        radial_points,
                        1,
                    ),
                    (
                        (electrochemical_temperature - 25.0) / 20.0
                    )[:, :, None, None].expand(
                        batch,
                        time_steps,
                        radial_points,
                        1,
                    ),
                ),
                dim=-1,
            )
            concentration_correction = (
                self.config.domain_concentration_correction_limit
                * torch.tanh(
                    self.domain_concentration_residual_adapter(
                        concentration_features
                    )
                )
                * multiphysics_gate[:, :, None, None]
            )
            concentration_correction = (
                concentration_correction
                - concentration_correction[:, :1]
            )
            concentration = (
                concentration + concentration_correction
            ).clamp(0.001, 0.999)
            average = radial_volume_average(concentration)
        voltage_v, voltage_input = voltage_from(
            concentration,
            electrochemical_temporal,
            electrochemical_temperature,
        )
        if (
            self.config.domain_residual_adapter_version >= 1
            and not native_v10_guard
        ):
            capacity_signal = (
                capacity_ratio.reshape(batch, 1).expand(batch, time_steps)
                if capacity_ratio is not None
                else torch.ones_like(current_c_rate)
            )
            initial_soc_signal = (
                initial_soc.reshape(batch, 1).expand(batch, time_steps)
                if initial_soc is not None
                else torch.full_like(current_c_rate, 0.5)
            )
            domain_features = torch.cat(
                (
                    electrochemical_temporal,
                    current_c_rate.unsqueeze(-1),
                    (
                        (electrochemical_temperature - 25.0) / 20.0
                    ).unsqueeze(-1),
                    capacity_signal.unsqueeze(-1),
                    initial_soc_signal.unsqueeze(-1),
                ),
                dim=-1,
            )
            domain_voltage_correction = (
                self.config.domain_voltage_correction_limit_v
                * torch.tanh(
                    self.domain_voltage_residual_adapter(
                        domain_features
                    ).squeeze(-1)
                )
            )
            if self.config.domain_residual_adapter_version >= 2:
                domain_gate = torch.tanh(
                    self.domain_residual_gate(
                        chemistry_index
                    ).squeeze(-1)
                )
                domain_voltage_correction = (
                    domain_voltage_correction
                    * domain_gate.reshape(batch, 1)
                )
            voltage_v = (
                voltage_v + domain_voltage_correction
            ).clamp(2.0, 5.0)
        state_temperature = electrochemical_temperature
        if self.config.soc_head_version >= 2:
            if initial_soc is None or duration_hours is None:
                raise ValueError(
                    "SOC Head v2 需要 initial_soc 和 duration_hours。"
                )
            trapezoid_current = current_c_rate.clone()
            trapezoid_current[:, 0] = 0.0
            trapezoid_current[:, 1:] = 0.5 * (
                current_c_rate[:, 1:] + current_c_rate[:, :-1]
            )
            coulomb_soc = (
                initial_soc.reshape(batch, 1)
                + torch.cumsum(
                    trapezoid_current * delta_time,
                    dim=1,
                )
                * duration_hours.reshape(batch, 1)
                / (
                    capacity_ratio.reshape(batch, 1).clamp_min(0.5)
                    if self.config.health_conditioned_version == 1
                    and capacity_ratio is not None
                    else 1.0
                )
            )
            if self.config.soc_head_version >= 4:
                cumulative_time = delta_time.cumsum(dim=1)
                soc_features = torch.stack(
                    (
                        current_c_rate,
                        (state_temperature - 25.0) / 20.0,
                        cumulative_time,
                        delta_time,
                        coulomb_soc,
                        initial_soc.reshape(batch, 1).expand_as(coulomb_soc),
                    ),
                    dim=-1,
                )
                raw_correction = self.soc_correction_head(
                    soc_features
                ).squeeze(-1)
                correction = self.config.soc_correction_limit * torch.tanh(
                    raw_correction - raw_correction[:, :1]
                )
            elif self.config.soc_head_version >= 3:
                soc_features = torch.cat(
                    (
                        # SOC supervision must not pull the shared physical
                        # representation away from concentration/PDE training.
                        temporal.detach(),
                        current_c_rate.unsqueeze(-1),
                        ((state_temperature - 25.0) / 20.0).unsqueeze(-1),
                        coulomb_soc.unsqueeze(-1),
                    ),
                    dim=-1,
                )
                raw_correction = self.soc_correction_head(
                    soc_features
                ).squeeze(-1)
                # Anchor at t=0 and bound the entire relative adjustment.
                correction = self.config.soc_correction_limit * torch.tanh(
                    raw_correction - raw_correction[:, :1]
                )
            else:
                correction = 0.15 * torch.tanh(
                    self.soc_correction_head(voltage_input).squeeze(-1)
                )
                correction = correction - correction[:, :1]
            soc = (coulomb_soc + correction).clamp(0.0, 1.0)
        else:
            soc = average[:, :, 0]
            correction = torch.zeros_like(soc)
        if (
            self.config.transfer_adapter_version >= 1
            and not native_v10_guard
        ):
            voltage_v = (
                voltage_v + transfer_calibration[:, 0:1]
            ).clamp(2.0, 5.0)
            # Phase one validates voltage residual calibration only. SOC
            # remains anchored to coulomb integration and temperature remains
            # governed by the thermal operator until their support residuals
            # prove stable across held-out cells.
        if (
            self.config.physical_identifier_version >= 1
            and self.config.transfer_safe_mode_version < 1
        ):
            # Effective R0/Rp/OCV corrections are bounded and only become
            # active after the separate identifier gate is trained.
            signed_current = current_c_rate
            polarization_current = torch.cumsum(
                signed_current * delta_time,
                dim=1,
            ) / delta_time.cumsum(dim=1).clamp_min(1e-6)
            voltage_v = (
                voltage_v
                + 0.08 * effective_physical_parameters[:, 4:5]
                - 0.04
                * effective_physical_parameters[:, 1:2]
                * signed_current
                - 0.02
                * effective_physical_parameters[:, 2:3]
                * polarization_current
            ).clamp(2.0, 5.0)
        if (
            self.config.degradation_head_version >= 1
            and not native_v10_guard
        ):
            capacity_condition = (
                capacity_ratio.reshape(batch, 1).expand(batch, time_steps)
                if capacity_ratio is not None
                else torch.ones_like(current_c_rate)
            )
            degradation_features = torch.cat(
                (
                    degradation_temporal,
                    current_c_rate.abs().unsqueeze(-1),
                    (
                        (temperature_c_prediction - 25.0).abs() / 20.0
                    ).unsqueeze(-1),
                    cumulative_throughput.unsqueeze(-1),
                    capacity_condition.unsqueeze(-1),
                    ((voltage_v - 3.4).abs() / 0.8).unsqueeze(-1),
                ),
                dim=-1,
            )
            degradation_rate = torch.nn.functional.softplus(
                self.degradation_head(degradation_features)
            )
            degradation_increment = degradation_rate * delta_time.unsqueeze(-1)
            degradation_growth = torch.cumsum(
                degradation_increment,
                dim=1,
            )
            degradation_growth = (
                degradation_growth - degradation_growth[:, :1, :]
            )
            initial_capacity_loss = (
                (1.0 - capacity_ratio.reshape(batch)).clamp(0.0, 0.8)
                if capacity_ratio is not None
                else torch.zeros(
                    batch,
                    device=current_c_rate.device,
                    dtype=current_c_rate.dtype,
                )
            )
            degradation_baseline = torch.stack(
                (
                    initial_capacity_loss,
                    torch.zeros_like(initial_capacity_loss),
                ),
                dim=-1,
            )
            if (
                self.config.degradation_context_version >= 1
                and degradation_context is not None
            ):
                degradation_baseline = (
                    degradation_baseline
                    + degradation_context_strength * degradation_prior
                )
            degradation_scale = current_c_rate.new_tensor((0.05, 0.20))
            degradation_state = (
                degradation_baseline[:, None, :]
                + degradation_growth * degradation_scale
            )
        else:
            degradation_state = current_c_rate.new_zeros(
                batch,
                time_steps,
                2,
            )
        return SPMPINOTransformerOutput(
            concentration=concentration,
            voltage_v=voltage_v,
            soc=soc,
            route_weights=route_weights,
            route_risk_features=fast_risk,
            fast_concentration=fast_concentration,
            operator_concentration=operator_concentration,
            soc_correction=correction,
            temperature_c=temperature_c_prediction,
            fast_voltage_v=fast_voltage_v,
            operator_voltage_v=operator_voltage_v,
            effective_diffusivity=effective_diffusivity,
            thermal_parameters=thermal_parameters,
            activation_k=activation_k,
            degradation_state=degradation_state,
            degradation_prior=degradation_prior,
            physics_attention_weights=physics_attention_weights,
            transfer_adapter_strength=transfer_adapter_strength,
            transfer_calibration=transfer_calibration,
            identified_physical_parameters=identified_physical_parameters,
            effective_physical_parameters=effective_physical_parameters,
            physical_parameter_confidence=physical_parameter_confidence,
            protocol_context_strength=protocol_context_strength,
        )

    def set_radial_resolution(self, radial_points: int) -> None:
        if radial_points < 4:
            raise ValueError("radial_points 必须至少为 4。")
        self._requested_radial_points = radial_points

    def checkpoint_payload(self, metadata: dict[str, object]) -> dict[str, object]:
        return {
            "config": asdict(self.config),
            "state_dict": self.state_dict(),
            "metadata": metadata,
        }
