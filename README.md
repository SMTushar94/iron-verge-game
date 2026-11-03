# IRON VERGE — 2D side-stepping run-and-gun (live-service mobile game)

Production-ready, fully typed TypeScript architecture for an iOS/Android
run-and-gun, plus a **playable, self-contained browser demo driven by the exact
same engine, state store and service contracts**.

> **Stack decision (ADR-001):** React Native + TypeScript + `@shopify/react-native-skia`.
> One codebase ships both platforms; Skia gives GPU-accelerated vector drawing
> (Metal / Vulkan) while keeping the artwork as code. The simulation is 100%
> platform-agnostic, so native Swift/Kotlin only supply SDK bridges and a vsync
> clock — those contracts are implemented in `/src/native`. Swapping to fully
> native Swift/Kotlin later means replacing the renderer + UI shell, not the game.

---

## 1. Try it in 30 seconds

```bash
cd /home/user/metal-run
npm install --legacy-peer-deps

npm run build:demo     # bundles TS -> one offline HTML file
npm run typecheck      # strict tsc over engine + RN + web harness
npm test               # 15 deterministic engine / economy / SDK unit tests
npm run dev:demo       # http://localhost:8080/web/index.html  (live preview)
npm run smoke          # Playwright E2E (needs: npx playwright install chromium)
```

**No install needed:** open `IRON-VERGE-playable-demo.html` directly — it is a
single 166 KB file with all JS/CSS/SVG inlined, no CDN, no network, no assets.
It works in the workspace file viewer and offline in a browser.

Controls (demo): `WASD`/arrows move · mouse aims 360° · hold left click fires ·
`Space` jump · **HOLD `G` to charge a grenade, release to throw** · `1–4` weapons ·
`Shift` crouch · **crouch + jump = side-step dodge with i-frames** · `P`/`Esc`
pause · `E` armory. On touch, drag the left half for the floating movement stick,
the right half for the aim stick, and use JUMP / FIRE / **hold NADE** buttons.

![Home](docs/screenshots/01-home.png)
![Gameplay](docs/screenshots/02-gameplay.png)
![Armory](docs/screenshots/03-armory.png)
![Hold-to-charge grenade](docs/screenshots/06-grenade-charge.png)
![All character faces](docs/screenshots/07-faces-zoom.png)

---

## 2. Folder structure

```
iron-verge/
├── App.tsx                         # RN entry point (native SDK composition)
├── src/
│   ├── engine/                     # ★ ZERO React / RN / DOM dependencies
│   │   ├── core/                   # GameLoop (fixed 60 Hz), Math2D, RNG, pools, events, config
│   │   ├── input/                  # InputSnapshot + InputAdapter (edge/held buffering)
│   │   ├── render/                 # DrawCommands, Toon cel-shading, Parallax, Camera, Scene, Buses
│   │   │   └── adapters/           # Canvas2DRenderer (demo) · SkiaRenderer (RN production)
│   │   └── sim/                    # World, Physics, Player, Enemies, Weapons, Projectiles,
│   │                               # Grenades, Particles, Pickups, Spawner, Combat
│   ├── state/                      # Zustand vanilla store, catalog, selectors, persistence
│   ├── services/                   # IAP, Ads, Network/Cloud, Telemetry, DI container
│   │   ├── iap/                    # MockIAPService · StoreKitIAP · PlayBillingIAP · validators
│   │   ├── ads/                    # MockAdService · RNAdService · HttpRewardVerifier
│   │   └── network/                # ApiClient · CloudSave · ShopRotation · Idempotency
│   ├── components/                 # RN UI: /hud /controls /shop /common
│   ├── game/                       # GameRuntime (orchestration), Provider, Screen, Screens
│   ├── native/                     # Swift (StoreKit 2, CADisplayLink) + Kotlin (Billing 7, Choreographer)
│   └── types/rn-shims.d.ts         # ambient RN/Skia types for Node-only CI (DELETE in host app)
├── web/                            # browser harness: main.ts, input.ts, ui.ts, style.css, shell.html
├── scripts/                        # build-demo.mjs, run-tests.mjs
├── tests/                          # 15 unit tests + Playwright E2E smoke
├── docs/                           # ARCHITECTURE.md, INTEGRATION.md, screenshots
└── IRON-VERGE-playable-demo.html   # generated, self-contained deliverable
```

The four separations you asked for are exact: `/engine` (rendering + physics),
`/components` (UI + shop), `/services` (network + IAP + ads), `/state` (Zustand).
`/game` holds only orchestration glue, `/web` only the browser harness.

---

## 3. Core systems

### 3.1 Game loop & rendering — `src/engine/core/GameLoop.ts`, `src/engine/render/`

| Requirement | Implementation |
| --- | --- |
| 60 FPS loop | Fixed `1/60` accumulator, max 5 sub-steps, spiral-of-death guard, render interpolation `alpha`. `FrameSource` is injected: `requestAnimationFrame` (web), Reanimated/`CADisplayLink`/`Choreographer` (native). |
| Cel-shaded vectors | `Toon.ts` emits a dark base polygon + a hard-edged clipped highlight band + heavy ink outline (`clipAbove()` / `clipBelow()` Sutherland–Hodgman). Shading is hex math, no shaders required → identical on Canvas2D and Skia. |
| Detailed faces | `Faces.ts` draws a full face for **all 6 character classes** (player, grunt, gunner, drone, turret, brute): eyes with sclera/pupil/glint + blink, brows that angle with mood, nose, mouth with teeth/grimace, ears, jaw shading, cheek flush, scars, stubble, and class headgear (helmet/visor/headset, bandana/goggles, cap/monocle/cigar, brow plate/tusks, hex optic, sensor slit). Expressions are driven by live sim state (hit flash, firing timer, dodge, grenade charge). The armour-shop preview reuses the same `drawFace()`. |
| Parallax | `Parallax.ts`: 5 infinite chunked layers (cloud 0.04 → near debris 1.18), deterministic per-chunk seeded geometry (`hash2`), so scrolling backwards reproduces the same skyline and allocates no persistent meshes. |
| Particles | `Particles.ts`: fixed 900-slot pool, zero per-frame allocation; sparks, ejected casings, muzzle flash, missile smoke, dust, scrap glints, explosion embers. |
| Screen shake | `Camera.ts`: trauma model with `amplitude = trauma²`, smooth sin-sum noise, decay 1.9/s, plus smooth follow/look-ahead and zoom. |
| Renderer swap | `Renderer` interface + serialisable `RenderFrame { screen, world, overlay }` command buffer. `Canvas2DRenderer` and `SkiaRenderer` consume the **same** commands. `NullRenderer` for tests. |

```
InputSnapshot ──► World.step(dt) ──► plain arrays ──► buildRenderFrame() ──► RenderFrame
                      │                                                        │
                      └─ EventBus (kills, damage, scrap)                ┌─────┴─────┐
                         └─► store / analytics / audio          Canvas2D      Skia
```

### 3.2 Controls — `src/components/controls/`, `src/engine/input/`

- **Left floating thumbstick** (`VirtualJoystick.tsx`): Reanimated UI-thread gesture;
  normalised vector crosses the bridge via `runOnJS`. Pulling down past 0.58
  crouches; crouch + jump performs the invulnerable side-step dodge.
- **Right aim stick**: full 360° vector; fall back to facing direction when idle.
  `AimMode = 'free' | 'eight-way'` — 8-way snaps to 45° via `quantize8()`.
- **Right buttons**: JUMP (edge), FIRE (held, supports auto-fire), GRENADE (edge),
  plus a 4-slot weapon strip that routes locked weapons into the armory.
- `InputAdapter.consumeEdges()` runs at the end of every fixed step, so a jump or
  grenade can never fire twice or be dropped between frames.

### 3.3 Weapons & combat — `src/engine/sim/Weapons.ts`, `Combat.ts`, `Projectiles.ts`, `Grenades.ts`

| Weapon | Behaviour | DMG | RPM | Mag |
| --- | --- | --- | --- | --- |
| VK-9 Vanguard (AR) | Full-auto, 3.4° spread | 14 | 620 | 30 |
| BRK-12 Breaker (SG) | 8 pellets, 21° cone, heavy knockback | 11 ×8 | 100 | 8 |
| ARC-7 Lancelot (RG) | Hitscan lance, pierces 12 targets, beam FX | 96 | 58 | 6 |
| HVR-3 Hornet (MS) | Homing (3.8 rad/s), 96 px splash, smoke trail | 48 + AoE | 135 | 4 |

- Continuous **swept collision** (`segmentAABB`) prevents tunnelling at 60 Hz.
- **Grenades — HOLD TO CHARGE (tap = CLOSE, hold = FAR)**: pressing the grenade
  button starts a 1.05 s charge; horizontal throw speed ramps 230 → 940 px/s on an
  ease-out curve while the launch lift flattens −640 → −430. Direction always
  follows the live aim angle, so a tap lobs steeply into a nearby cluster and a
  full hold drives a fast, flat grenade ~3× farther. `computeThrowVelocity()` is
  the single source of truth shared by the actual throw and `predictThrow()`, so
  the dotted ballistic arc, charge ring, `CLOSE / MID / FAR` label and blast-radius
  ring drawn while charging are exact, never decorative. HUD charge bar on both web
  and RN. Grenades still bounce 3×, have a 1.35 s fuse, quadratic radial falloff,
  shockwave + sparks + 0.82 trauma, and one-at-a-time charge regeneration.
- Enemies: grunt / gunner / drone / turret / brute with per-kind AI, a wave
  director that ramps cadence and mix, combo scoring and scrap drops.
- All gameplay randomness comes from the seeded `RNG` — **replays are bit-identical**.

### 3.4 Live-service shop & economy — `src/state/`, `src/components/shop/`

- **Dual currency** dashboard: `Scrap Metal` (earned in runs + rewarded ads) and
  `Gears` (premium IAP). Both are mutated only inside `createGameStore()`.
- **Rotating Armory** (`ShopRotation.ts`): deterministic 6-hour rotation derived
  from `(server time bucket, live-ops seed)`, 6 offers, guaranteed ≥1 per
  category, occasional 10/15/20% discount, signed payload in production. The
  offline client computes the identical payload, so the store works on a plane.
- **Preview → unlock → equip**: weapons, armour skins and passive utilities.
  Utilities compose into `LoadoutModifiers` (`selectors.ts`) that the simulation
  reads at run start: +HP, ×scrap, +grenade charge, −cooldown, skin palette.
- **Persistence** (`persist.ts`): local-first hydrate, cloud reconcile with
  revision conflict resolution, debounced save. **Premium Gears are
  server-authoritative — never last-write-wins.** Migration by `SAVE_VERSION`.

### 3.5 SDK integration hooks — `src/services/`

```
                 ┌────────────── ServiceContainer (DI) ──────────────┐
   UI / store ──►│ IAPService   AdService   ShopBackend   CloudSave   │
                 │  ▲  ▲          ▲             ▲            ▲        │
                 │  │  └── Mock…  └── Mock…     └── Mock…   └── Local… │
                 │  └── StoreKitIAP / PlayBillingIAP / RNAdService / HTTP
                 └─────────────────────────────────────────────────────┘
```

| Hook | Mock (dev) | Production |
| --- | --- | --- |
| IAP | `MockIAPService` (sandbox sheet, latency, failure injection) | `StoreKitIAP` → `IVStoreKitBridge.swift` (StoreKit 2) · `PlayBillingIAP` → `IVPlayBillingBridge.kt` (Billing 7) |
| Receipts | `MockReceiptValidator` | `ServerReceiptValidator` → `POST /v1/iap/verify` |
| Rewarded ads | `MockAdService` (interstitial + HMAC-ish single-use token) | `RNAdService` (host ad SDK) + `HttpRewardVerifier` → `POST /v1/ads/verify` |
| Cloud save | `LocalCloudSave` | `HttpCloudSave` → `/v1/players/:id/save` |
| Shop | `MockRotationBackend` | `HttpShopBackend` → `/v1/shop/rotation` |
| Telemetry | `consoleAnalytics` | `BatchedAnalytics` (20 events / 10 s flush) |

**The client never grants premium currency.** A purchase or completed ad yields
an opaque receipt/token; only a server-verified `Entitlement` reaches the store.
Every mutating request carries an `Idempotency-Key`. Interrupted transactions are
observed from cold start (`Transaction.updates` on iOS, `queryPurchasesAsync` on
Android) and Android purchases are acknowledged only after verification.

---

## 4. Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | strict TS, 0 errors across engine + RN components + web harness |
| `npm test` | 15/15 passing: determinism, seed divergence, 8-way aim, swept collision, fixed-step loop, pooling, rotation determinism, conflict resolution, ad replay rejection, entitlement gating, grenade cooldown, modifier composition, **charge velocity/landing distance**, **input edge+held latching**, **charge-through-`World.step()`** |
| `npm run smoke` | Playwright E2E: deploy → combat (score/kills) → **hold-to-charge grenade** → armory → rewarded ad (+250) → IAP (+60 Gears) → **zero console errors**; also captures all-6-faces and trajectory screenshots |

---

## 5. What is real vs. mocked

**Real / production-grade:** the game loop, physics, hit detection, all four
weapons, charge-throw grenade + exact trajectory preview, expressive faces for all
character classes, enemy AI, particles, parallax, shake, cel renderer contract,
input buffering, Zustand store, catalog, rotation algorithm, persistence & conflict
resolution, idempotency, telemetry batching, StoreKit/Play Billing bridge
contracts, Swift/Kotlin bridge implementations, and the entire RN UI layer.

**Mocked by design:** backend HTTP endpoints (behind `ApiClient` interfaces),
StoreKit/Play Billing SDKs (`MockIAPService`), ad SDK (`MockAdService`), and
receipt/SSV validation. Swap `createMockServices()` → `createNativeServices()` in
`App.tsx`; no feature code changes. See `docs/INTEGRATION.md`.

---

## 6. Production notes

- Delete `src/types/rn-shims.d.ts` once the RN host app installs the real
  dependencies; it exists so a plain Node CI job can typecheck the RN layer.
- `SkiaStage` re-renders Skia nodes per frame for clarity. For the shipped build,
  record commands into a `Skia.PictureRecorder` inside Reanimated's
  `useFrameCallback` and render one `<Picture>` node — the command-buffer design
  makes that a drop-in change with zero edits to `/engine/sim`.
- Lock the sim to 60 Hz even on 120 Hz ProMotion devices; interpolate rendering.
- `src/engine/core/GameConfig.ts` is the single tuning surface for designers — including `grenade.chargeTime`, `minThrowSpeed`, `maxThrowSpeed`, `shortLift`, `longLift`.

Detailed rationale: **[ARCHITECTURE.md](ARCHITECTURE.md)** ·
SDK wiring: **[docs/INTEGRATION.md](docs/INTEGRATION.md)** ·
native bridges: **[src/native/README.md](src/native/README.md)**
