@echo off
REM Start backend and frontend for local development (run from the repo root).
echo Starting GenAI Customer Simulator...

start "Backend" cmd /k "cd /d %~dp0backend && python -m uvicorn app.main:app --reload"

timeout /t 3 /nobreak >nul

start "Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo Backend:  http://localhost:8000/docs
echo Frontend: http://localhost:3000
echo.
