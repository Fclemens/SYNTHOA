@echo off
echo Starting GenAI Customer Simulator...

start "Backend" cmd /k "cd /d C:\Users\fclem\OneDrive\Documenti\GenAI_Survey_SIM\backend && python -m uvicorn app.main:app --reload"

timeout /t 3 /nobreak >nul

start "Frontend" cmd /k "cd /d C:\Users\fclem\OneDrive\Documenti\GenAI_Survey_SIM\frontend && npm run dev"

echo.
echo Backend:  http://localhost:8000/docs
echo Frontend: http://localhost:3000
echo.
