@echo off
echo ==========================================
echo    LAUNCHING NEXUS AI PLATFORM
echo ==========================================

:: 1. Start the AI Backend
echo [1/2] Starting AI Backend (Port 3001)...
start /B cmd /c "cd /d c:\Users\USER\OneDrive\Desktop\Peojects\my-ollama-mcp && npm run build && node dist/server.js"

:: 2. Start the SaaS Dashboard
echo [2/2] Starting SaaS Dashboard (Port 5174)...
start /B cmd /c "cd /d c:\Users\USER\OneDrive\Desktop\Peojects\ai-ecommerce-dashboard && npm run dev"

echo.
echo ==========================================
echo    SYSTEMS ARE LIVE!
echo ==========================================
echo Dashboard: http://localhost:5174
echo API Server: http://localhost:3001
echo ==========================================
pause
