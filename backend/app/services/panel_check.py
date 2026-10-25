"""
Panel check: does the sampled persona panel match the audience definition?
Compares each variable's target distribution with what was actually sampled,
and each target correlation with the realised one.
"""
from __future__ import annotations
from typing import Any

import numpy as np

from .sampling import DEFAULT_BUCKET_LABELS, clip_to_bounds, inverse_cdf

N_BINS = 12
_GRID = (np.arange(2000) + 0.5) / 2000   # quantile grid for the theoretical distribution


def _option_labels(dist: dict[str, Any]) -> list[str]:
    return [o["label"] if isinstance(o, dict) else str(o) for o in dist.get("options", [])]


def _option_weights(dist: dict[str, Any]) -> list[float]:
    opts = dist.get("options", [])
    weights = [max(float(o.get("weight", 1)), 0) if isinstance(o, dict) else 1.0 for o in opts]
    total = sum(weights) or 1.0
    return [w / total for w in weights]


def _is_bucketed(var) -> bool:
    d = var.distribution
    return var.var_type == "continuous" and bool(d.get("normalize_labels") or d.get("bucket_labels"))


def _labels_for(var) -> list[str] | None:
    """Ordered category labels for non-numeric variables (None = numeric)."""
    if var.var_type in ("categorical", "ordinal"):
        return _option_labels(var.distribution)
    if _is_bucketed(var):
        return var.distribution.get("bucket_labels") or DEFAULT_BUCKET_LABELS[5]
    return None


def _target_shares(var, labels: list[str]) -> list[float]:
    if _is_bucketed(var):
        return [1 / len(labels)] * len(labels)   # buckets are equal-probability cuts
    return _option_weights(var.distribution)


def _theoretical_sample(dist: dict[str, Any]) -> np.ndarray:
    values = np.array([clip_to_bounds(inverse_cdf(dist, float(u)), dist) for u in _GRID])
    if dist.get("round_to_int"):
        values = np.round(values)
    return values


def _encode(var, value: Any, labels: list[str] | None) -> float | None:
    """Numeric encoding used for correlations: ordered index for labels, raw value otherwise."""
    if value is None:
        return None
    if labels is not None:
        return float(labels.index(value)) if value in labels else None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def build_panel_check(variables: list, correlations: list, rules: list, personas: list[dict]) -> dict:
    n = len(personas)
    ruled = {r.target_var_id for r in rules}
    out_vars = []
    for var in variables:
        labels = _labels_for(var)
        values = [p.get(var.name) for p in personas]
        entry: dict[str, Any] = {"id": var.id, "name": var.name, "var_type": var.var_type,
                                 "has_rules": var.id in ruled}
        if labels is not None:
            counts = [sum(1 for v in values if v == label) for label in labels]
            entry["kind"] = "categorical"
            entry["categories"] = [
                {"label": label, "target": round(t, 4), "actual": round(c / n, 4) if n else 0.0}
                for label, t, c in zip(labels, _target_shares(var, labels), counts)
            ]
            entry["max_gap"] = max((abs(c["target"] - c["actual"]) for c in entry["categories"]), default=0.0)
        else:
            sampled = np.array([float(v) for v in values if isinstance(v, (int, float))])
            theo = _theoretical_sample(var.distribution)
            lo = float(min(theo.min(), sampled.min() if sampled.size else theo.min()))
            hi = float(max(theo.max(), sampled.max() if sampled.size else theo.max()))
            if hi <= lo:
                hi = lo + 1.0
            edges = np.linspace(lo, hi, N_BINS + 1)
            t_hist = np.histogram(theo, bins=edges)[0] / len(theo)
            s_hist = np.histogram(sampled, bins=edges)[0] / max(len(sampled), 1)
            entry["kind"] = "numeric"
            entry["bins"] = [
                {"lo": round(float(a), 4), "hi": round(float(b), 4), "target": round(float(t), 4), "actual": round(float(s), 4)}
                for a, b, t, s in zip(edges[:-1], edges[1:], t_hist, s_hist)
            ]
            entry["target_mean"] = round(float(theo.mean()), 3)
            entry["target_std"] = round(float(theo.std()), 3)
            entry["actual_mean"] = round(float(sampled.mean()), 3) if sampled.size else None
            entry["actual_std"] = round(float(sampled.std()), 3) if sampled.size else None
        out_vars.append(entry)

    by_id = {v.id: v for v in variables}
    out_corr = []
    for c in correlations:
        a, b = by_id.get(c.var_a_id), by_id.get(c.var_b_id)
        if not a or not b:
            continue
        la, lb = _labels_for(a), _labels_for(b)
        pairs = [(_encode(a, p.get(a.name), la), _encode(b, p.get(b.name), lb)) for p in personas]
        pairs = [(x, y) for x, y in pairs if x is not None and y is not None]
        actual = None
        if len(pairs) >= 3:
            xs, ys = np.array(pairs).T
            if xs.std() > 0 and ys.std() > 0:
                actual = round(float(np.corrcoef(xs, ys)[0, 1]), 3)
        out_corr.append({"var_a": a.name, "var_b": b.name, "target": c.correlation, "actual": actual})

    return {"n_personas": n, "variables": out_vars, "correlations": out_corr}
