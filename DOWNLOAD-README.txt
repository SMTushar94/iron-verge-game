IRON VERGE — full project export
Generated 2026-11-03 from /home/user/metal-run

WHAT'S INSIDE
  src/                 platform-agnostic engine, RN UI, state, services (83+ TS/TSX files)
  App.tsx, src/native/ React Native entry + Swift/Kotlin SDK bridges
  web/                 browser harness + generated self-contained web/index.html
  IRON-VERGE-playable-demo.html   single-file offline playable demo (open directly in a browser)
  scripts/, tests/     build script, 15 unit tests, Playwright E2E smoke
  docs/screenshots/    7 screenshots (home, gameplay, armory, ads, IAP, charge throw, faces)
  README.md, ARCHITECTURE.md, docs/INTEGRATION.md, src/native/README.md
  package.json, package-lock.json, tsconfig.json

QUICK START
  npm install --legacy-peer-deps
  npm run typecheck
  npm test
  node scripts/build-demo.mjs     # regenerates the self-contained HTML
  python3 -m http.server 8080 --bind 0.0.0.0 -d web    # serve the browser build
  Or simply open IRON-VERGE-playable-demo.html in any browser (no install needed).

NOT INCLUDED
  node_modules/ and generated caches (recreate with npm install).
  This is not a git repository: there is no .git, no commit, no remote.
