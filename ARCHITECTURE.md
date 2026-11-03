# IRON VERGE — Architecture Decision Records & System Design

## ADR-001 · React Native + Skia over two native codebases

| | RN + Skia | Native Swift + Kotlin |
| --- | --- | --- |
| Shared gameplay code | 100% | duplicated |
| Live-ops UI iteration | instant (one codebase) | 2 implementations |
| Vector rendering | Skia → Metal/Vulkan | 2 bespoke renderers |
| SDK access | thin native bridges | direct |

Chosen: **RN + TypeScript + Skia**. Native code is confined to SDK bridges and a
vsync clock (`/src/native`). Crucially, `/engine` has **zero** RN/DOM imports, so
the renderer and UI shell remain replaceable without rewriting gameplay.

## ADR-002 · Headless deterministic simulation

`World.step(dt, input)` is a pure function of `(previous state, fixed dt, input)`.
No `Date.now()`, no `Math.random()`, no platform APIs. Benefits:

1. Replay / bug reports: record the input stream + seed, reproduce exactly.
2. Unit tests run in Node with `NullRenderer` (`tests/engine.test.ts` proves
   two worlds with the same seed produce identical state after 900 steps).
3. The sim can move to a worker or to a server-authoritative anti-cheat validation
   path without changes.
4. Physics never varies with device refresh rate (60/90/120 Hz all identical).

`Math.random()` is used **only** in `ParticleSystem` for visual jitter; it cannot
feed back into simulation state.

## ADR-003 · Retained command buffer instead of direct drawing

The sim builds `RenderFrame { screen[], world[], overlay[] }` of plain objects.
Renderers are adapters. Consequences:

- `Canvas2DRenderer` (browser demo), `SkiaRenderer` (RN), `NullRenderer` (CI)
  produce identical artwork from the same data.
- Frames can be recorded, diffed and replayed.
- Cel shading is expressed as 2–3 polygons per shape (`Toon.ts`), not a fragment
  shader — portable to any backend, and cheap on mid-tier Android GPUs.
- Screen-space parallax and world-space entities are separated by the renderer's
  transform, so the camera (including shake) affects gameplay but not the sky.

## ADR-004 · Fixed timestep + render interpolation

```
frame(now):
  realDt = clamp(now - last, 0, 0.25)
  accumulator += realDt
  while accumulator >= 1/60 and steps < 5:
      World.step(1/60, input); input.consumeEdges(); accumulator -= 1/60
  if steps == 5 and backlog: drop backlog, increment droppedFrames
  render(alpha = accumulator / dt)
```

`alpha` is exposed on `onRender` for position interpolation; the current build
redraws at sim positions (sufficient at 60 Hz and keeps the demo compact).
`droppedFrames` is surfaced in the HUD as a live performance signal.

## ADR-005 · Economy is server-authoritative for premium currency

```
run kills ─► Scrap pickups ─► World.scrapEarned ─► applyRunResult() ─► wallet.scrap
rewarded ad ─► SDK token ─► POST /v1/ads/verify ─► verified amount ─► wallet.scrap
IAP ─► receipt/JWS ─► POST /v1/iap/verify ─► Entitlement ─► wallet.gears
                                        ▲
                        single grant path: onTransaction()
```

Rules enforced in code:

- `spend()` and `purchaseItem()` are the only wallet debits; `grantScrap` /
  `grantGears` the only credits.
- `resolveConflict()` never accepts the client's Gears value; it unions
  unlocks and takes max progression, then bumps the revision.
- All credits/debits bump `revision`, which drives debounced persistence.
- `newIdempotencyKey()` + `Idempotency-Key` header on every mutating POST.
- `MockAdService` tokens are single-use: a replay is rejected (unit test 9).

## ADR-006 · Rotating shop is deterministic, not random-per-client

`computeRotation(serverNow, liveOpsSeed)` buckets time into 6-hour windows and
seeds a PRNG with `(seed XOR bucket * golden ratio)`. Every client computes the
same offers; the server signs the payload for production so prices cannot be
tampered with. Offline players still see a valid store, and QA can jump to any
rotation by injecting `services.clock()`.

## Data flow

```
 ┌──────────────┐  InputSnapshot   ┌────────────────────────────┐
 │ Touch / KB   │ ───────────────► │        World (sim)         │
 │ InputAdapter │                  │  player/enemies/bullets/…  │
 └──────────────┘                  └───────┬────────────┬───────┘
                                           │ events     │ state
                                  ┌────────▼──────┐    │
                                  │  EventBus     │    │
                                  │ analytics /   │    │
                                  │ audio / store │    │
                                  └───────────────┘    │
                                              ┌────────▼─────────┐
                                              │ buildRenderFrame  │
                                              │  RenderFrame      │
                                              └────────┬──────────┘
                                     ┌──────────────────┴───────────┐
                              ┌──────▼──────┐               ┌───────▼──────┐
                              │ Canvas2D    │               │ Skia (RN)    │
                              │ (demo/CI)   │               │ (production) │
                              └─────────────┘               └──────────────┘

 ┌───────────────────────────────────────────────────────────────────────┐
 │ Zustand store  ◄── applyRunResult / purchaseItem / claimRewardedScrap  │
 │      ▲ ▲   │                                                          │
 │      │ │   └──► selectModifiers() ─► World.configure() at run start     │
 │      │ └──────► persistence (local first, cloud reconcile)             │
 │      └────────► React components (useGameStore, HUD, ArmoryShop)       │
 └───────────────────────────────────────────────────────────────────────┘
```

## Run state machine

`ready → playing ⇄ paused → dead(→ results) → playing`. `GameLoop.pause()`
stops stepping but keeps rendering; `World.runState` gates simulation mutations.
Opening any modal pauses the sim; closing it resumes only if the previous state
was `playing`.

## Performance budget (target: 60 FPS on a 4 GB Android device)

| Subsystem | Budget | Strategy |
| --- | --- | --- |
| Simulation | < 1.5 ms | plain arrays, in-place `prune()`, no allocations, seeded RNG |
| Frame assembly | < 2 ms | command objects only; parallax emits visible chunks |
| Particles | < 1 ms | fixed 900-slot pool, single loop, no GC |
| Skia raster | < 6 ms | flat fills, 2-tone polygons, no blur/shadow filters |
| React UI | < 1 ms | HUD bus throttled to 10 Hz; frame bus isolated from React state |
| Persistence | off hot path | debounce 600 ms, async storage |

Instrumentation: `LoopStats` (fps, frameMs, steps, droppedFrames) is exposed via
`GameLoop.onStats` and printed in the demo HUD.

## Testing strategy

| Layer | Tool | Coverage |
| --- | --- | --- |
| Sim invariants | `node:test` | determinism, physics, weapons, cooldowns, pooling |
| Economy | `node:test` | rotation, conflict resolution, modifier composition |
| SDK contracts | `node:test` | token replay, entitlement gating |
| UI wiring | Playwright E2E | deploy → combat → shop → ad → IAP, zero console errors |
| Type safety | `tsc --strict` | all `src/**` + `web/**` + `tests/**` |
| Native | Xcode / Gradle CI | compile Swift/Kotlin bridges (host app) |

## Security checklist

- [x] Client never grants Gears; server-verified entitlement only
- [x] Idempotency keys on purchase / verify / save
- [x] Cold-start transaction observation (StoreKit / Play Billing)
- [x] Android acknowledge-after-verification
- [x] Reward token single-use, amount from server
- [ ] Pin and verify the shop rotation signature with a public key (stub: `signature` field)
- [ ] Certificate pinning + request signing on `ApiClient`
- [ ] Server-side anti-cheat: replay the input stream to validate run rewards


## ADR-007 · Hold-to-charge ordnance with a truthful trajectory preview

Charge is **simulation state** (`PlayerState.grenadeCharge` / `grenadeCharging`),
not UI state, so it is deterministic, replayable and visible to anti-cheat. The
input adapter keeps `grenadeHeld` separate from the latched `grenadePressed` edge;
`updateGrenadeThrow()` accumulates charge on each fixed step and throws on the
release step. A legacy edge-only adapter still gets an immediate short lob.

`computeThrowVelocity(world, angle, charge)` is the ONE velocity model used by
both `throwGrenade()` and `predictThrow()`. The preview therefore cannot drift
from the real projectile: same semi-implicit integration, same gravity, same
`groundY - 8` collision plane, same aim angle. Charge scales speed with
`easeOutCubic` and flattens the lob, giving ~3× range at full charge while
preserving 360°/8-way directional control.

The charge arc, dotted ballistic path, `CLOSE/MID/FAR` label and blast-radius
ring are emitted into `RenderFrame.world` by `Scene.drawThrowPreview()`, so they
appear identically on Canvas2D and Skia with no additional UI code.

## ADR-008 · Faces as a shared render module

`Faces.ts` owns one `drawFace()` used by the player, all five enemy classes and
the armour-shop preview. Expression is a pure function of sim state (hit flash,
fire timer, dodge, charge, low HP), which keeps visual feedback consistent with
gameplay instead of duplicating animation state. Blink timing is derived from
`time + entity id`, so it stays deterministic and each character blinks out of
phase. All geometry uses the cel-shaded `DrawList` contract (no bitmaps), so
faces scale cleanly across screen densities and remain replayable.
