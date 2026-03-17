"""
Algorithm 1: Correlated Population Sampling
Uses Cholesky decomposition + Gaussian copula to produce correlated personas.
"""
from __future__ import annotations
import logging
import random
from typing import Any

import numpy as np
from scipy.stats import beta as beta_dist
from scipy.stats import expon, gamma, lognorm, norm, triang, uniform
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.audience import AudienceVariable, ConditionalRule

logger = logging.getLogger(__name__)


# ── Nearest PSD via eigenvalue clamping ────────────────────────────────────────

def nearest_psd(matrix: np.ndarray) -> np.ndarray:
    """Higham's algorithm approximation: clamp negative eigenvalues to epsilon."""
    eigvals, eigvecs = np.linalg.eigh(matrix)
    eigvals = np.maximum(eigvals, 1e-8)
    psd = eigvecs @ np.diag(eigvals) @ eigvecs.T
    # Re-normalise diagonal to 1 (correlation matrix)
    d = np.sqrt(np.diag(psd))
    psd = psd / np.outer(d, d)
    return psd


def is_positive_semidefinite(matrix: np.ndarray) -> bool:
    try:
        np.linalg.cholesky(matrix)
        return True
    except np.linalg.LinAlgError:
        return False


# ── Inverse CDF per distribution type ─────────────────────────────────────────

def inverse_cdf(dist: dict[str, Any], u: float) -> float:
    """Map uniform u ∈ [0,1] to the target marginal distribution."""
    t = dist["type"]
    if t == "normal":
        return float(norm.ppf(u, loc=dist["mean"], scale=dist["std"]))
    elif t == "log_normal":
        real_mean = dist["real_mean"]
        real_std = dist["real_std"]
        sigma2 = np.log(1 + (real_std / real_mean) ** 2)
        mu = np.log(real_mean) - sigma2 / 2
        sigma = np.sqrt(sigma2)
        return float(lognorm.ppf(u, s=sigma, scale=np.exp(mu)))
    elif t == "uniform":
        return float(uniform.ppf(u, loc=dist["min"], scale=dist["max"] - dist["min"]))
    elif t == "triangular":
        lo, hi, mode = dist["min"], dist["max"], dist["mode"]
        c = (mode - lo) / (hi - lo)
        return float(triang.ppf(u, c=c, loc=lo, scale=hi - lo))
    elif t == "beta":
        return float(beta_dist.ppf(u, a=dist["alpha"], b=dist["beta"]))
    elif t == "exponential":
        lam = dist.get("lambda", dist.get("lambda_", 1.0))
        return float(expon.ppf(u, scale=1.0 / lam))
    elif t == "gamma":
        return float(gamma.ppf(u, a=dist["alpha"], scale=dist["beta"]))
    else:
        raise ValueError(f"Unknown distribution type: {t}")


def clip_to_bounds(value: float, dist: dict[str, Any]) -> float:
    lo = dist.get("min_clip")
    hi = dist.get("max_clip")
    if lo is not None:
        value = max(value, lo)
    if hi is not None:
        value = min(value, hi)
    return value


def sample_categorical(dist: dict[str, Any]) -> str:
    options = dist["options"]
    labels = [o["label"] for o in options]
    weights = [o.get("weight", 1.0) for o in options]
    total = sum(weights)
    weights = [w / total for w in weights]
    return random.choices(labels, weights=weights, k=1)[0]


def evaluate_condition(expr: dict[str, Any], traits: dict[str, Any]) -> bool:
    var_val = traits.get(expr["var"])
    if var_val is None:
        return False
    op = expr["op"]
    threshold = expr["value"]
    if op == "<":
        return var_val < threshold
    elif op == "<=":
        return var_val <= threshold
    elif op == ">":
        return var_val > threshold
    elif op == ">=":
        return var_val >= threshold
    elif op == "==":
        return var_val == threshold
    elif op == "!=":
        return var_val != threshold
    return False


# ── Main sampling function ─────────────────────────────────────────────────────

async def sample_correlated_population(
    audience_id: str,
    n: int,
    db: AsyncSession,
) -> list[dict[str, Any]]:
    """
    Sample n correlated personas from the audience's variable definitions.
    Returns list of trait dicts.
    """
    # Load variables
    result = await db.execute(
        select(AudienceVariable)
        .where(AudienceVariable.audience_id == audience_id)
        .order_by(AudienceVariable.sort_order)
    )
    all_vars = result.scalars().all()

    cont_vars = [v for v in all_vars if v.var_type == "continuous"]
    cat_vars = [v for v in all_vars if v.var_type == "categorical"]

    # Load correlations
    from ..models.audience import VariableCorrelation
    corr_result = await db.execute(
        select(VariableCorrelation).where(VariableCorrelation.audience_id == audience_id)
    )
    correlations = corr_result.scalars().all()

    # Load conditional rules (sorted by priority ascending — higher priority applied last)
    rule_result = await db.execute(
        select(ConditionalRule)
        .where(ConditionalRule.audience_id == audience_id)
        .order_by(ConditionalRule.priority)
    )
    rules = rule_result.scalars().all()

    k = len(cont_vars)
    var_index = {v.id: i for i, v in enumerate(cont_vars)}

    personas: list[dict[str, Any]] = []

    if k > 0:
        # Build correlation matrix
        R = np.eye(k)
        for corr in correlations:
            i = var_index.get(corr.var_a_id)
            j = var_index.get(corr.var_b_id)
            if i is not None and j is not None:
                R[i, j] = corr.correlation
                R[j, i] = corr.correlation

        if not is_positive_semidefinite(R):
            R = nearest_psd(R)
            logger.warning(f"Correlation matrix for audience {audience_id} was not PSD; auto-corrected.")

        L = np.linalg.cholesky(R)
        Z = np.random.standard_normal((n, k))
        correlated_Z = Z @ L.T

        for row in correlated_Z:
            traits: dict[str, Any] = {}
            for idx, var in enumerate(cont_vars):
                u = float(norm.cdf(row[idx]))
                u = max(1e-6, min(1 - 1e-6, u))  # avoid ppf at 0/1
                value = inverse_cdf(var.distribution, u)
                value = clip_to_bounds(value, var.distribution)
                traits[var.name] = round(value, 2)

            # Categorical variables with conditional rules
            for cat_var in cat_vars:
                dist = dict(cat_var.distribution)
                for rule in rules:
                    if rule.target_var_id == cat_var.id and evaluate_condition(rule.condition_expr, traits):
                        dist = rule.override_dist
                traits[cat_var.name] = sample_categorical(dist)

            personas.append(traits)
    else:
        # Only categorical variables
        for _ in range(n):
            traits = {}
            for cat_var in cat_vars:
                dist = dict(cat_var.distribution)
                for rule in rules:
                    if rule.target_var_id == cat_var.id and evaluate_condition(rule.condition_expr, traits):
                        dist = rule.override_dist
                traits[cat_var.name] = sample_categorical(dist)
            personas.append(traits)

    return personas
