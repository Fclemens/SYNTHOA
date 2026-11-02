# SYNTHOA

*by fclementi*. Synthetic customer research with LLMs: define an **audience** (a statistical
population of personas), write an **experiment** (questions + variables), run
it as simulated interviews, and analyse the extracted answers.

Workflow: Audience → sample personas → Experiment (variables, questions,
output schema) → test with 1 persona → launch → run → analysis.

## Desktop app (portable)

`SYNTHOA.exe` runs the app in its own window: no Python, Node or browser needed on the target PC.

**Build it** (needs Python 3.11+ and Node.js 20+ on the build PC): double-click

```text
BUILD_EXE.bat
```

It builds outside this folder (in `%LOCALAPPDATA%\SynthoaBuild`, so OneDrive does not sync the build files)
and produces:

- `dist\SYNTHOA\SYNTHOA.exe`: the app folder
- `SYNTHOA-win64.zip`: the same folder zipped, to copy to another PC

**Use it:** unzip anywhere and run `SYNTHOA.exe`. Everything stays inside that folder: `data\` (database
`synthoa.db`, settings and API keys, editable prompts) and `logs\app.log` (for troubleshooting). Copy the folder
to move SYNTHOA, data included. API keys are entered on the Settings page (or put in `data\.env`).

Notes:

- Requires Windows 10/11 with Microsoft Edge WebView2 (preinstalled on current Windows).
- The exe is not code-signed: Windows SmartScreen may warn on first launch (`More info` → `Run anyway`).
- No window wanted (or no WebView2)? `SYNTHOA.exe --serve 8000` runs it headless; open http://127.0.0.1:8000.
- Closing the window stops running simulations; resume them from the run page. Batch runs keep going at the
  provider and are picked up at the next start.

## Run it from source

**Docker**:

```bash
cp .env.example .env      # add OPENAI_API_KEY and/or ANTHROPIC_API_KEY
docker compose up --build
```

Frontend: http://localhost:3000 · API docs: http://localhost:8000/docs

**Local dev**: `start.bat` on Windows, or

```bash
cd backend && pip install -r requirements.txt && uvicorn app.main:app --reload
cd frontend && npm install && npm run dev
```

**Single process**: build the frontend as static files and the backend serves it at http://localhost:8000:

```bash
cd frontend && STATIC_EXPORT=1 npm run build      # writes frontend/out
cd ../backend && uvicorn app.main:app
```

`python backend/desktop.py` (with `pip install pywebview`) opens that in a desktop window.

## Models and providers

Each pipeline step (Pass 1 interview, Pass 2 extraction, backstories,
insights) has its own provider and model, set on the Settings page:

- `openai`: OpenAI API (defaults: `gpt-6.1-sol` for interviews, `gpt-6-luna` for extraction)
- `anthropic`: Claude API (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, …)
- `lmstudio`: any OpenAI-compatible local server (LM Studio, Ollama, vLLM)

Token prices live in Settings → Token Pricing. A model without a price shows
$0 cost, and the Launch tab warns about it. A run locks its models,
providers and its full protocol (context, questions, variables) at launch,
so retries and resumes reproduce it even if the experiment is edited later.

**Prompt caching.** Prompts put the part shared by every persona (survey,
extraction schema) first and mark it as cacheable; costs use each model's
cached-input price (default 10% of input).

**Batch mode.** For pooled runs on OpenAI or Anthropic, tick *Batch mode* on
the Launch tab to submit the run through the provider's Batch API: half price,
results within 24 hours. One persona runs live first to check the setup.
Batch runs survive a backend restart; polling resumes where it left off.

## Tests

```bash
cd backend && pip install -r requirements-dev.txt && python -m pytest
```

The suite runs the full pipeline (sampling → launch → interview → extraction
→ analysis) against a fake LLM, so it needs no API keys or network.

## Notes

- Data lives in SQLite (`DATABASE_URL`). Schema changes are applied
  automatically at startup.
- Runs that were in progress when the backend stopped are marked
  *cancelled* at the next start. Use **Resume** on the run page to finish them.
  Batch runs are the exception: they keep waiting on their provider batch.
- See `AUDIENCES_REFERENCE.txt` for the audience/sampling model in detail.
