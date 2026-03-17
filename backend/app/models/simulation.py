import uuid
from datetime import datetime
from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.types import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from ..database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class SimulationRun(Base):
    __tablename__ = "simulation_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    experiment_id: Mapped[str] = mapped_column(String, ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False)
    model_pass1: Mapped[str] = mapped_column(String, nullable=False)
    model_pass2: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending")
    # pending → running → completed | failed | cancelled
    total_tasks: Mapped[int] = mapped_column(Integer, nullable=False)
    completed_tasks: Mapped[int] = mapped_column(Integer, default=0)
    failed_tasks: Mapped[int] = mapped_column(Integer, default=0)
    total_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    locked_config: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)

    experiment: Mapped["Experiment"] = relationship(back_populates="runs")  # type: ignore[name-defined]
    tasks: Mapped[list["SimulationTask"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class SimulationTask(Base):
    __tablename__ = "simulation_tasks"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String, ForeignKey("simulation_runs.id", ondelete="CASCADE"), nullable=False)
    persona_id: Mapped[str] = mapped_column(String, ForeignKey("personas.id"), nullable=False)
    injected_vars: Mapped[dict] = mapped_column(JSON, nullable=False)

    # Pass 1
    pass1_status: Mapped[str] = mapped_column(String, default="pending")
    pass1_prompt: Mapped[str | None] = mapped_column(String)
    raw_transcript: Mapped[str | None] = mapped_column(String)
    pass1_tokens_in: Mapped[int | None] = mapped_column(Integer)
    pass1_tokens_out: Mapped[int | None] = mapped_column(Integer)
    pass1_cost_usd: Mapped[float | None] = mapped_column(Float)
    pass1_error: Mapped[str | None] = mapped_column(String)

    # Drift detection
    drift_scores: Mapped[list | None] = mapped_column(JSON)
    drift_flagged: Mapped[bool] = mapped_column(Boolean, default=False)

    # Pass 2
    pass2_status: Mapped[str] = mapped_column(String, default="pending")
    extracted_json: Mapped[dict | None] = mapped_column(JSON)
    extraction_confidence: Mapped[dict | None] = mapped_column(JSON)
    extraction_disagreements: Mapped[dict | None] = mapped_column(JSON)
    pass2_tokens_in: Mapped[int | None] = mapped_column(Integer)
    pass2_tokens_out: Mapped[int | None] = mapped_column(Integer)
    pass2_cost_usd: Mapped[float | None] = mapped_column(Float)
    pass2_error: Mapped[str | None] = mapped_column(String)

    run: Mapped["SimulationRun"] = relationship(back_populates="tasks")


class CalibrationBenchmark(Base):
    __tablename__ = "calibration_benchmarks"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    experiment_id: Mapped[str] = mapped_column(String, ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False)
    question_id: Mapped[str] = mapped_column(String, ForeignKey("questions.id"), nullable=False)
    real_distribution: Mapped[list] = mapped_column(JSON, nullable=False)
    synthetic_distribution: Mapped[list] = mapped_column(JSON, nullable=False)
    js_divergence: Mapped[float] = mapped_column(Float, nullable=False)
    sample_size_real: Mapped[int] = mapped_column(Integer, nullable=False)
    sample_size_synthetic: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class CalibrationStatus(Base):
    __tablename__ = "calibration_status"

    experiment_id: Mapped[str] = mapped_column(
        String, ForeignKey("experiments.id", ondelete="CASCADE"), primary_key=True
    )
    level: Mapped[str] = mapped_column(String, nullable=False, default="uncalibrated")
    # "uncalibrated" | "directional" | "calibrated"
    last_calibrated: Mapped[datetime | None] = mapped_column(DateTime)
    notes: Mapped[str | None] = mapped_column(String)
