@echo off
REM Quick Role Setup Script for Windows

echo.
echo ========================================
echo   WhatsApp AI - Role System Setup
echo ========================================
echo.

echo [Step 1] Navigating to backend folder...
cd /d "%~dp0backend" || exit /b 1

echo [Step 2] Running migration script...
echo.
node scripts/migrate-add-roles.js

if %errorlevel% equ 0 (
    echo.
    echo ========================================
    echo ✅ Migration completed successfully!
    echo ========================================
    echo.
    echo Next steps:
    echo 1. Start backend: npm start
    echo 2. Start frontend: npm start (in frontend folder)
    echo 3. Login as admin@gmail.com to test admin dashboard
    echo 4. Create new user to test user dashboard
    echo.
) else (
    echo.
    echo ========================================
    echo ❌ Migration failed!
    echo ========================================
    echo Check the error above and ensure:
    echo - MongoDB is running
    echo - MONGODB_URI env var is set
    echo.
    pause
    exit /b 1
)

pause
