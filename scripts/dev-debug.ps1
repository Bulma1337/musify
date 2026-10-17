# Starts the full app (`npm run tauri dev`) with the WebView2 DevTools protocol on port 9222, so
# scripts/tauri-e2e.mjs can drive and inspect the real app window.
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
Set-Location (Join-Path $PSScriptRoot "..")
npm run tauri dev
