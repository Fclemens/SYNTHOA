import uuid
from datetime import datetime
from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.types import JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from ..database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class Audience(Base):
    __tablename__ = "audiences"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(String)
    backstory_prompt_template: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    variables: Mapped[list["AudienceVariable"]] = relationship(
        back_populates="audience", cascade="all, delete-orphan", order_by="AudienceVariable.sort_order"
    )
    correlations: Mapped[list["VariableCorrelation"]] = relationship(
        back_populates="audience", cascade="all, delete-orphan"
    )
    conditional_rules: Mapped[list["ConditionalRule"]] = relationship(
        back_populates="audience", cascade="all, delete-orphan"
    )
    personas: Mapped[list["Persona"]] = relationship(
        back_populates="audience", cascade="all, delete-orphan"
    )

    @property
    def persona_count(self) -> int:
        return len(self.personas)


class AudienceVariable(Base):
    __tablename__ = "audience_variables"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    audience_id: Mapped[str] = mapped_column(String, ForeignKey("audiences.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    var_type: Mapped[str] = mapped_column(String, nullable=False)  # "continuous" | "categorical"
    distribution: Mapped[dict] = mapped_column(JSON, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    audience: Mapped["Audience"] = relationship(back_populates="variables")


class VariableCorrelation(Base):
    __tablename__ = "variable_correlations"

    audience_id: Mapped[str] = mapped_column(String, ForeignKey("audiences.id", ondelete="CASCADE"), primary_key=True)
    var_a_id: Mapped[str] = mapped_column(String, ForeignKey("audience_variables.id"), primary_key=True)
    var_b_id: Mapped[str] = mapped_column(String, ForeignKey("audience_variables.id"), primary_key=True)
    correlation: Mapped[float] = mapped_column(Float, nullable=False)

    audience: Mapped["Audience"] = relationship(back_populates="correlations")


class ConditionalRule(Base):
    __tablename__ = "conditional_rules"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    audience_id: Mapped[str] = mapped_column(String, ForeignKey("audiences.id", ondelete="CASCADE"), nullable=False)
    condition_expr: Mapped[dict] = mapped_column(JSON, nullable=False)  # {"var": "age", "op": "<", "value": 25}
    target_var_id: Mapped[str] = mapped_column(String, ForeignKey("audience_variables.id"), nullable=False)
    override_dist: Mapped[dict] = mapped_column(JSON, nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=0)

    audience: Mapped["Audience"] = relationship(back_populates="conditional_rules")


class Persona(Base):
    __tablename__ = "personas"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    audience_id: Mapped[str] = mapped_column(String, ForeignKey("audiences.id", ondelete="CASCADE"), nullable=False)
    traits_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    backstory: Mapped[str | None] = mapped_column(String)
    plausibility: Mapped[float | None] = mapped_column(Float)
    flagged: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    audience: Mapped["Audience"] = relationship(back_populates="personas")


class SamplingJob(Base):
    __tablename__ = "sampling_jobs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=_uuid)
    audience_id: Mapped[str] = mapped_column(String, ForeignKey("audiences.id", ondelete="CASCADE"), nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="running")
    # running | stopped | completed | failed
    n_requested: Mapped[int] = mapped_column(Integer, nullable=False)
    n_completed: Mapped[int] = mapped_column(Integer, default=0)
    backstory_mode: Mapped[str] = mapped_column(String, default="llm")
    generate_backstories: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1")  # legacy compat
    validate_plausibility: Mapped[bool] = mapped_column(Boolean, default=True)
    llm_validation: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    error: Mapped[str | None] = mapped_column(String)
