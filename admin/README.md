# Modelry Admin Foundation

This workspace contains the React + TypeScript Admin shell. Its browser smoke test must run against a real Modelry Runtime; it does not install response mocks or start a Vite server as the system under test.

From the repository root:

```powershell
npm ci
npm run admin:build
npm test
$env:MODELRY_BASE_URL = 'http://127.0.0.1:8080'
npm run admin:browser-smoke
```

Start the Go Runtime with an isolated Project Root before running the browser smoke. Playwright uses the installed Google Chrome when `CHROME_PATH` points to it or the standard Windows Chrome path exists, and otherwise uses its managed Chromium. The smoke gate checks actual Runtime and Storage HTTP responses, the canonical structured error/request ID, route navigation, reload, deep-link delivery, browser console/page errors, failed requests, and HTTP 5xx responses. The outer foundation harness compares `modelry status --json` Project IDs before and after a real Runtime restart.

`npm run admin:build` emits committed assets to `internal/webui/dist` for the single-binary Go embed. Do not exclude that directory from version control.
