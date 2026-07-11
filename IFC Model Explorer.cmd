@echo off
rem IFC Model Explorer — opens big IFC files, lists every element with its
rem rebar/embeds, 3D view with click-select, exports any element as its own IFC.
cd /d "%~dp0"
title IFC Model Explorer
py -3.10 server.py %*
pause
