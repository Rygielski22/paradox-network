@echo off
title Paradox VPS Pull
echo.
echo Run this ON THE VPS after pushing from your PC:
echo   cd /root/paradox-network ^&^& git pull ^&^& bash deploy.sh
echo.
echo Or if only code changed (no package.json deps):
echo   cd /root/paradox-network ^&^& git pull ^&^& pm2 restart paradox-proxy
echo.
pause