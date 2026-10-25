"""
Algorithm 4: Experiment variable resolution.
Experiment variables are referenced as {name} in the global context and question
text, and sampled once per task (stored on the task as injected_vars).
"""
from __future__ import annotations
import random
from typing import Any

from .sampling import inverse_cdf, sample_categorical


def sample_from_distribution(dist: dict[str, Any]) -> str:
    """Sample a single value from a distribution config dict and return as string."""
    if dist["type"] == "categorical":
        return sample_categorical(dist)

    u = min(max(random.random(), 1e-9), 1 - 1e-9)  # avoid ±inf at the boundaries
    try:
        v = inverse_cdf(dist, u)
    except ValueError:
        return str(dist)

    lo_clip, hi_clip = dist.get("min_clip"), dist.get("max_clip")
    if lo_clip is not None:
        v = max(v, lo_clip)
    if hi_clip is not None:
        v = min(v, hi_clip)

    if dist.get("round_to_int") or v == int(v):
        return str(int(round(v)))
    return f"{v:.2f}"


def resolve_dist_variables(
    text: str,
    dist_vars: list[Any],  # ExperimentDistVariable ORM objects
    cache: dict[str, str],
) -> str:
    """Replace {variable_name} tokens with sampled values, reusing `cache` for consistency."""
    for var in dist_vars:
        token = f"{{{var.name}}}"
        if token in text:
            if var.name not in cache:
                cache[var.name] = sample_from_distribution(var.distribution)
            text = text.replace(token, cache[var.name])
    return text
