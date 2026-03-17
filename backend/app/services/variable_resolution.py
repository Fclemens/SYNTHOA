"""
Algorithm 4: Variable Resolution & Synonym Injection
"""
from __future__ import annotations
import random
from typing import Any

import numpy as np
from scipy.stats import beta as _beta, expon as _expon, gamma as _gamma
from scipy.stats import lognorm as _lognorm, norm as _norm, triang as _triang, uniform as _uniform


def weighted_sample(attributes: list[dict[str, Any]]) -> str:
    """Sample one attribute value based on weights. Normalises to uniform if weights missing."""
    values = [str(a["value"]) for a in attributes]
    weights = [float(a.get("weight", 1.0)) for a in attributes]
    total = sum(weights)
    if total == 0:
        weights = [1.0] * len(weights)
        total = float(len(weights))
    weights = [w / total for w in weights]
    return random.choices(values, weights=weights, k=1)[0]


def resolve_variables(
    text: str,
    experiment_vars: list[Any],  # list of ExperimentVariable ORM objects
    resolved_cache: dict[str, str],
) -> str:
    """
    Replace all {{Variable}} placeholders with sampled values.
    Uses resolved_cache to ensure consistency within a single task.
    """
    for var in experiment_vars:
        placeholder = f"{{{{{var.placeholder}}}}}"
        if placeholder in text:
            if var.placeholder not in resolved_cache:
                resolved_cache[var.placeholder] = weighted_sample(var.attributes)
            text = text.replace(placeholder, resolved_cache[var.placeholder])
    return text


def sample_from_distribution(dist: dict[str, Any]) -> str:
    """Sample a single value from a distribution config dict and return as string."""
    t = dist["type"]
    if t == "categorical":
        options = dist["options"]
        labels = [o["label"] for o in options]
        weights = [float(o.get("weight", 1.0)) for o in options]
        total = sum(weights)
        weights = [w / total for w in weights]
        return random.choices(labels, weights=weights, k=1)[0]

    u = random.random()
    u = max(1e-9, min(1 - 1e-9, u))  # avoid -inf/+inf at boundaries

    if t == "normal":
        v = float(_norm.ppf(u, loc=dist["mean"], scale=dist["std"]))
    elif t == "log_normal":
        rm, rs = dist["real_mean"], dist["real_std"]
        sigma2 = float(np.log(1 + (rs / rm) ** 2))
        mu = float(np.log(rm) - sigma2 / 2)
        v = float(_lognorm.ppf(u, s=float(np.sqrt(sigma2)), scale=float(np.exp(mu))))
    elif t == "uniform":
        v = float(_uniform.ppf(u, loc=dist["min"], scale=dist["max"] - dist["min"]))
    elif t == "triangular":
        lo, hi, mode = dist["min"], dist["max"], dist["mode"]
        c = (mode - lo) / (hi - lo)
        v = float(_triang.ppf(u, c=c, loc=lo, scale=hi - lo))
    elif t == "beta":
        v = float(_beta.ppf(u, a=dist["alpha"], b=dist["beta"]))
    elif t == "exponential":
        lam = dist.get("lambda", dist.get("lambda_", 1.0))
        v = float(_expon.ppf(u, scale=1.0 / lam))
    elif t == "gamma":
        v = float(_gamma.ppf(u, a=dist["alpha"], scale=dist["beta"]))
    else:
        return str(dist)

    # Apply optional clipping
    lo_clip = dist.get("min_clip")
    hi_clip = dist.get("max_clip")
    if lo_clip is not None:
        v = max(v, lo_clip)
    if hi_clip is not None:
        v = min(v, hi_clip)

    # Return as int string if value is whole number, else 2 decimal places
    return str(int(round(v))) if v == int(v) else f"{v:.2f}"


def resolve_dist_variables(
    text: str,
    dist_vars: list[Any],  # list of ExperimentDistVariable ORM objects
    cache: dict[str, str],
) -> str:
    """Replace {variable_name} tokens with sampled distribution values."""
    for var in dist_vars:
        token = f"{{{var.name}}}"
        if token in text:
            if var.name not in cache:
                cache[var.name] = sample_from_distribution(var.distribution)
            text = text.replace(token, cache[var.name])
    return text


def apply_synonym_injection(
    text: str,
    synonym_sets: list[Any],  # list of SynonymSet ORM objects
) -> str:
    """
    For each canonical term found in the text, randomly replace with
    one of its synonyms (including the canonical itself).
    """
    for ss in synonym_sets:
        if ss.canonical in text:
            options = [ss.canonical] + list(ss.synonyms)
            chosen = random.choice(options)
            text = text.replace(ss.canonical, chosen)
    return text
