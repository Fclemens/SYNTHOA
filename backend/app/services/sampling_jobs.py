"""
Background service for async persona sampling jobs.
Each persona is committed immediately so closing the page never loses progress.
"""
from __future__ import annotations
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from ..models.audience import Audience, Persona, SamplingJob
from ..services.backstory import generate_backstory, generate_backstory_template
from ..services.sampling import sample_correlated_population
from ..services.validation import validate_persona, validate_persona_llm
from ..config import settings

logger = logging.getLogger(__name__)


async def run_sampling_job(job_id: str) -> None:
    """
    Background task: sample personas one at a time, committing after each one.
    Checks job.status after each commit — stops cleanly if set to 'stopped'.
    """
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

    remaining = job.n_requested - job.n_completed

    for _ in range(remaining):
        # Open a fresh session per persona so each commit is independent
        async with AsyncSessionLocal() as db:
            # Re-fetch job to check for stop signal
            job = await db.get(SamplingJob, job_id)
            if not job or job.status == "stopped":
                return

            audience = await db.get(Audience, job.audience_id)
            if not audience:
                job.status = "failed"
                job.error = "Audience not found"
                await db.commit()
                return

            try:
                raw_traits = await sample_correlated_population(job.audience_id, 1, db)
                if not raw_traits:
                    continue
                traits = raw_traits[0]

                plausibility = None
                flagged = False
                if job.validate_plausibility:
                    score, _ = validate_persona(traits)
                    plausibility = score
                    flagged = score < settings.plausibility_threshold

                    if job.llm_validation and not flagged:
                        llm_score, _ = await validate_persona_llm(traits, settings.effective_validation_model)
                        plausibility = (score + llm_score) / 2
                        flagged = plausibility < settings.plausibility_threshold

                backstory = None
                mode = getattr(job, "backstory_mode", "llm")
                if mode == "llm":
                    backstory = await generate_backstory(
                        traits,
                        settings.effective_backstory_model,
                        provider=settings.effective_backstory_provider,
                        custom_template=audience.backstory_prompt_template,
                    )
                elif mode == "template":
                    backstory = generate_backstory_template(
                        traits,
                        custom_template=audience.backstory_prompt_template,
                    )

                persona = Persona(
                    id=str(uuid.uuid4()),
                    audience_id=job.audience_id,
                    traits_json=traits,
                    backstory=backstory,
                    plausibility=plausibility,
                    flagged=flagged,
                )
                db.add(persona)

                job.n_completed += 1
                await db.commit()

            except Exception as e:
                logger.error(f"Sampling job {job_id} error on persona {job.n_completed + 1}: {e}")
                job.status = "failed"
                job.error = str(e)
                await db.commit()
                return

    # All done — mark completed
    async with AsyncSessionLocal() as db:
        job = await db.get(SamplingJob, job_id)
        if job and job.status == "running":
            job.status = "completed"
            job.completed_at = datetime.now(timezone.utc)
            await db.commit()
