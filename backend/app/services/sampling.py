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
from scipy.stats import expon, gamma, lognorm, norm, poisson as poisson_dist, triang, truncnorm, uniform, weibull_min
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
    elif t == "truncated_normal":
        mean, std = dist["mean"], dist["std"]
        lo, hi = dist["min"], dist["max"]
        a, b = (lo - mean) / std, (hi - mean) / std
        return float(truncnorm.ppf(u, a=a, b=b, loc=mean, scale=std))
    elif t == "poisson":
        lam = dist.get("lambda", dist.get("lambda_", 1.0))
        # poisson.ppf returns a float; cast to int then back to float for trait consistency
        return float(int(poisson_dist.ppf(u, mu=lam)))
    elif t == "weibull":
        return float(weibull_min.ppf(u, c=dist["shape"], scale=dist["scale"]))
    elif t == "ordinal":
        # Map uniform u to integer category index using cumulative weights
        options = dist.get("options", [])
        n_opts = len(options)
        if n_opts == 0:
            return 0.0
        # options may be str[] (legacy equal-weight) or {label, weight}[] (weighted)
        if options and isinstance(options[0], dict):
            weights = [max(float(o.get("weight", 1)), 0) for o in options]
        else:
            weights = [1.0] * n_opts
        total = sum(weights) or n_opts
        cumulative = 0.0
        for idx, w in enumerate(weights):
            cumulative += w / total
            if u <= cumulative:
                return float(idx)
        return float(n_opts - 1)
    elif t == "categorical":
        # Binary categorical (exactly 2 options) — encode as 0/1 weighted by option weights
        options = dist.get("options", [])
        if len(options) < 2:
            return 0.0
        weights = [o.get("weight", 1.0) for o in options]
        total = sum(weights) or 1.0
        threshold = weights[0] / total
        return 0.0 if u < threshold else 1.0
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


# ── Bucket label normalisation ─────────────────────────────────────────────────

DEFAULT_BUCKET_LABELS = {
    2: ["Low", "High"],
    3: ["Low", "Medium", "High"],
    4: ["Low", "Medium-Low", "Medium-High", "High"],
    5: ["Very Low", "Low", "Medium", "High", "Very High"],
    6: ["Very Low", "Low", "Medium-Low", "Medium-High", "High", "Very High"],
    7: ["Very Low", "Low", "Below Average", "Average", "Above Average", "High", "Very High"],
}

def bucket_label(value: float, dist: dict[str, Any]) -> str:
    """Map a sampled numeric value to a label bucket using theoretical distribution quantiles.

    dist may contain:
      normalize_labels: true  (legacy — use 5 default buckets)
      bucket_labels: ["A","B","C",...]  (custom ordered labels, count = n buckets)
    """
    labels: list[str] = dist.get("bucket_labels") or DEFAULT_BUCKET_LABELS[5]
    n = len(labels)
    # Build n-1 threshold percentiles evenly spaced
    percentiles = [(i + 1) / n for i in range(n - 1)]
    thresholds = []
    for p in percentiles:
        u = max(1e-6, min(1 - 1e-6, p))
        try:
            thresholds.append(inverse_cdf(dist, u))
        except Exception:
            thresholds.append(value)
    for i, threshold in enumerate(thresholds):
        if value < threshold:
            return labels[i]
    return labels[-1]


def _toposort_cat_vars(cat_vars: list, rules: list) -> list:
    """Return cat_vars in an order that respects cat→cat conditional rule dependencies.

    If rule on var B references var A (condition_expr["var"] == A.name), A must be
    sampled before B.  Cycles are broken arbitrarily (should not occur in practice).
    """
    name_to_var = {v.name: v for v in cat_vars}
    id_to_var   = {v.id:   v for v in cat_vars}

    # Build adjacency: dep_of[var_id] = set of var_ids that must come before it
    dep_of: dict[str, set[str]] = {v.id: set() for v in cat_vars}
    for rule in rules:
        target = id_to_var.get(rule.target_var_id)
        if target is None:
            continue
        ref_name = rule.condition_expr.get("var")
        ref_var  = name_to_var.get(ref_name) if ref_name else None
        if ref_var and ref_var.id != target.id:
            dep_of[target.id].add(ref_var.id)

    # Kahn's algorithm
    sorted_ids: list[str] = []
    in_degree = {vid: len(deps) for vid, deps in dep_of.items()}
    queue = [vid for vid, deg in in_degree.items() if deg == 0]

    while queue:
        vid = queue.pop(0)
        sorted_ids.append(vid)
        for other_vid, deps in dep_of.items():
            if vid in deps:
                deps.discard(vid)
                in_degree[other_vid] -= 1
                if in_degree[other_vid] == 0:
                    queue.append(other_vid)

    # Any remaining (cycle) — append in original order
    seen = set(sorted_ids)
    for v in cat_vars:
        if v.id not in seen:
            sorted_ids.append(v.id)

    id_order = {vid: i for i, vid in enumerate(sorted_ids)}
    return sorted(cat_vars, key=lambda v: id_order.get(v.id, 999))


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
    ordinal_vars = [v for v in all_vars if v.var_type == "ordinal"]
    all_cat_vars = [v for v in all_vars if v.var_type == "categorical"]
    # Binary categoricals (exactly 2 options) join the Gaussian copula; others are sampled independently
    binary_cat_vars = [v for v in all_cat_vars if len(v.distribution.get("options", [])) == 2]
    cat_vars = [v for v in all_cat_vars if len(v.distribution.get("options", [])) != 2]
    # All variables that participate in the Cholesky copula
    copula_vars = cont_vars + ordinal_vars + binary_cat_vars

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

    cat_vars = _toposort_cat_vars(cat_vars, rules)

    k = len(copula_vars)
    var_index = {v.id: i for i, v in enumerate(copula_vars)}

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
            for idx, var in enumerate(copula_vars):
                u = float(norm.cdf(row[idx]))
                u = max(1e-6, min(1 - 1e-6, u))  # avoid ppf at 0/1
                value = inverse_cdf(var.distribution, u)

                if var.var_type == "ordinal":
                    # Decode float index → label (supports str[] and {label,weight}[])
                    opts = var.distribution.get("options", [])
                    i = max(0, min(int(value), len(opts) - 1))
                    if opts:
                        entry = opts[i]
                        traits[var.name] = entry["label"] if isinstance(entry, dict) else entry
                    else:
                        traits[var.name] = ""
                elif var.var_type == "categorical":
                    # Binary categorical: decode 0/1 → label
                    opts = var.distribution.get("options", [])
                    choice = int(round(value))
                    choice = max(0, min(choice, len(opts) - 1))
                    traits[var.name] = opts[choice]["label"] if opts else ""
                else:
                    # Continuous
                    value = clip_to_bounds(value, var.distribution)
                    if var.distribution.get("normalize_labels") or var.distribution.get("bucket_labels"):
                        traits[var.name] = bucket_label(value, var.distribution)
                    else:
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
