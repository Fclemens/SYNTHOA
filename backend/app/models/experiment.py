import uuid
from datetime import datetime
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.types import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from ..database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class Experiment(Base):
    __tablename__ = "experiments"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    audience_id: Mapped[str] = mapped_column(String, ForeignKey("audiences.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    global_context: Mapped[str] = mapped_column(String, nullable=False, default="")
    execution_mode: Mapped[str] = mapped_column(String, nullable=False, default="pooled")  # "pooled" | "dedicated"
    drift_detection_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    synonym_injection_enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1")  # legacy compat
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    variables: Mapped[list["ExperimentVariable"]] = relationship(
        back_populates="experiment", cascade="all, delete-orphan"
    )
    dist_variables: Mapped[list["ExperimentDistVariable"]] = relationship(
        back_populates="experiment", cascade="all, delete-orphan", order_by="ExperimentDistVariable.sort_order"
    )
    questions: Mapped[list["Question"]] = relationship(
        back_populates="experiment", cascade="all, delete-orphan", order_by="Question.sort_order"
    )
    output_schemas: Mapped[list["OutputSchema"]] = relationship(
        back_populates="experiment", cascade="all, delete-orphan", order_by="OutputSchema.version.desc()"
    )
    runs: Mapped[list["SimulationRun"]] = relationship(  # type: ignore[name-defined]
        back_populates="experiment", cascade="all, delete-orphan"
    )


class ExperimentVariable(Base):
    __tablename__ = "experiment_variables"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    experiment_id: Mapped[str] = mapped_column(String, ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False)
    placeholder: Mapped[str] = mapped_column(String, nullable=False)
    attributes: Mapped[list] = mapped_column(JSON, nullable=False)  # [{value, weight}, ...]

    experiment: Mapped["Experiment"] = relationship(back_populates="variables")


class ExperimentDistVariable(Base):
    __tablename__ = "experiment_dist_variables"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    experiment_id: Mapped[str] = mapped_column(String, ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    var_type: Mapped[str] = mapped_column(String, nullable=False)  # "continuous" | "categorical"
    distribution: Mapped[dict] = mapped_column(JSON, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    experiment: Mapped["Experiment"] = relationship(back_populates="dist_variables")


class Question(Base):
    __tablename__ = "questions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    experiment_id: Mapped[str] = mapped_column(String, ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    question_type: Mapped[str] = mapped_column(String, nullable=False)  # "scale" | "single_choice" | "multiple_choice" | "open_ended"
    question_text: Mapped[str] = mapped_column(String, nullable=False)
    scale_min: Mapped[int | None] = mapped_column(Integer)
    scale_max: Mapped[int | None] = mapped_column(Integer)
    scale_anchor_low: Mapped[str | None] = mapped_column(String)   # e.g. "Not at all likely"
    scale_anchor_high: Mapped[str | None] = mapped_column(String)  # e.g. "Extremely likely"
    choices: Mapped[list | None] = mapped_column(JSON)  # JSON array for single/multiple choice
    ask_why: Mapped[bool] = mapped_column(Boolean, default=False)
    prompting_mode: Mapped[str | None] = mapped_column(String)  # None | "pooled" | "dedicated"

    experiment: Mapped["Experiment"] = relationship(back_populates="questions")


class OutputSchema(Base):
    __tablename__ = "output_schemas"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    experiment_id: Mapped[str] = mapped_column(String, ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False)
    schema_json: Mapped[list] = mapped_column(JSON, nullable=False)  # [{key, type}, ...]
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    experiment: Mapped["Experiment"] = relationship(back_populates="output_schemas")
