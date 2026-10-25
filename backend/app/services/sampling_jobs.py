"""
Background service for async persona sampling jobs.
Traits for the whole job are sampled in one vectorised draw; backstories are
generated concurrently in small batches, each batch committed immediately so
stopping the job or closing the page never loses progress.
"""
from __future__ import annotations
import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from ..config import settings
from ..models.audience import Audience, Persona, SamplingJob
from ..services.backstory import generate_backstory, generate_backstory_template
from ..services.sampling import sample_correlated_population

logger = logging.getLogger(__name__)

BATCH_SIZE = 10


async def _backstory(mode: str, traits: dict[str, Any], template: str | None) -> str | None:
    if mode == "llm":
        return await generate_backstory(
            traits, settings.step_model("backstory"),
            provider=settings.step_provider("backstory"), custom_template=template,
        )
    if mode == "template":
        return generate_backstory_template(traits, custom_template=template)
    return None


async def run_sampling_job(job_id: str) -> None:
    """Sample the job's remaining personas; stops cleanly when the job is set to 'stopped'."""
    from ..database import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        job = await db.get(SamplingJob, job_id)
        if not job:
            return
        audience = await db.get(Audience, job.audience_id)
        if not audience:
            job.status = "failed"
            job.error = "Audience not found"
            await db.commit()
            return
        job.status = "running"
        await db.commit()
        audience_id, mode, template = job.audience_id, job.backstory_mode, audience.backstory_prompt_template
        remaining = job.n_requested - job.n_completed
        try:
            all_traits = await sample_correlated_population(audience_id, remaining, db) if remaining > 0 else []
        except Exception as e:
            logger.error(f"Sampling job {job_id} failed: {e}")
            job.status = "failed"
            job.error = str(e)
            await db.commit()
            return

    for start in range(0, len(all_traits), BATCH_SIZE):
        batch = all_traits[start:start + BATCH_SIZE]
        error: Exception | None = None
        try:
            stories = await asyncio.gather(*(_backstory(mode, t, template) for t in batch))
        except Exception as e:
            error = e

        async with AsyncSessionLocal() as db:
            job = await db.get(SamplingJob, job_id)
            if not job:
                return
            if error is not None:
                logger.error(f"Sampling job {job_id} failed: {error}")
                job.status = "failed"
                job.error = str(error)
                await db.commit()
                return
            # Keep a finished batch even if the job was paused meanwhile — it is already paid for.
            for traits, story in zip(batch, stories):
                db.add(Persona(id=str(uuid.uuid4()), audience_id=audience_id, traits_json=traits, backstory=story))
            job.n_completed += len(batch)
            await db.commit()
            if job.status != "running":
                return

    async with AsyncSessionLocal() as db:
        job = await db.get(SamplingJob, job_id)
        if job and job.status == "running":
            job.status = "completed"
            job.completed_at = datetime.now(timezone.utc)
            await db.commit()
