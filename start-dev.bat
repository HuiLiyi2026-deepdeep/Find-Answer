@echo off
setlocal
cd /d "%~dp0"

python -c "import fastapi, chromadb, httpx, pypdf, dotenv, multipart, uvicorn, keyring" >nul 2>&1
if errorlevel 1 (
  echo [FindAnswer] Python or required backend dependencies are unavailable.
  echo [FindAnswer] Run: cd backend ^&^& python -m pip install -r requirements.txt
  pause
  exit /b 1
)

if not exist "frontend\node_modules" (
  echo [FindAnswer] Frontend dependencies are missing. Run: cd frontend ^&^& npm install
  pause
  exit /b 1
)

start "FindAnswer API" cmd /k "cd /d ""%~dp0backend"" && python -m uvicorn app.main:app --reload --port 8000"
start "FindAnswer Web" cmd /k "cd /d ""%~dp0frontend"" && npm run dev -- --host 127.0.0.1"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:5173"
endlocal
