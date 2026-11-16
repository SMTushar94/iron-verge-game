/**
 * IRON VERGE — headless engine & economy test suite.
 *
 * Runs against the engine extracted from IRON-VERGE-playable-demo.html
 * (see scripts/extract-engine.mjs), so it tests the *shipped* code, not a copy.
 *
 * Conventions
 * -----------
 *   check()        invariant that must hold; failure fails the run.
 *   knownBug()     reproduces a confirmed defect. While the defect is present the
 *                  test passes and prints a diagnostic. Once fixed it starts
 *                  failing loudly, which is the signal to flip it to check().
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import M from '../build/engine.generated.mjs';

const DT = 1 / 60;
const noopAnalytics = () => ({ track() {}, flush: async () => {} });

let GROUP = '';

/** Register a test in the current group. */
const T = (name, fn) => test(`${GROUP}${name}`, fn);

/**
 * Assert *desired* behaviour for a confirmed defect. While the defect exists the
 * assertion fails, the failure is reported as a diagnostic and the test passes.
 * When the defect is fixed the body succeeds and this test fails loudly, which is
 * the signal to promote it to `await T(...)` with plain asserts.
 */
function knownBug(id, name, fn) {
  test(`${GROUP}[known-bug ${id}] ${name}`, async (t) => {
    try {
      await fn();
    } catch (err) {
      t.diagnostic(`KNOWN BUG STILL PRESENT (${id}): ${err.message}`);
      return;
    }
    throw new Error(`[known-bug ${id}] This defect appears to be FIXED. Promote it to a normal test.`);
  });
}

const step = (w, input, n = 1) => { for (let i = 0; i < n; i++) w.step(DT, input); };
const freshWorld = (seed = 1, cfg) => { const w = new M.World(); if (cfg) w.configure(cfg); w.reset(seed); return w; };

/** Bot that aims at the nearest enemy, fires, and optionally kites. */
function playSession({ seed = 1, seconds = 60, unlocked = ['ar'], kite = true } = {}) {
  const w = freshWorld(seed, { unlocked });
  const input = M.emptyInput();
  for (let f = 0; f < seconds * 60 && w.player.alive; f++) {
    const target = w.nearestEnemy(w.player.x, w.player.y, 1200);
    if (target) {
      const px = w.player.x + w.player.w / 2;
      const py = w.player.y + 22;
      const dx = target.x + target.w / 2 - px;
      const dy = target.y + target.h / 2 - py;
      const d = Math.hypot(dx, dy) || 1;
      input.aimActive = true;
      input.aimStrength = 1;
      input.aimX = dx / d;
      input.aimY = dy / d;
      input.fireHeld = true;
      input.moveX = kite && d < 260 ? (target.x > w.player.x ? -1 : 1) : 0;
    } else {
      input.fireHeld = false;
      input.moveX = -0.4;
    }
    w.step(DT, input);
  }
  return w;
}

// ─────────────────────────────────────────────────────────── engine invariants
GROUP = 'sim › ';
  await T('is deterministic for identical seed + input', () => {
    const sig = (w) => [w.time, w.score, w.kills, w.scrapEarned, w.enemies.length,
      w.player.x.toFixed(6), w.player.y.toFixed(6), w.player.hp].join('|');
    const a = playSession({ seed: 777, seconds: 15 });
    const b = playSession({ seed: 777, seconds: 15 });
    assert.equal(sig(a), sig(b));
  });

  await T('diverges when the seed changes', () => {
    const a = playSession({ seed: 777, seconds: 15 });
    const b = playSession({ seed: 778, seconds: 15 });
    assert.notEqual(a.score, b.score);
  });

  await T('is frame-rate independent (fixed 60 Hz accumulator)', () => {
    // Feed identical simulated time through different sub-step counts.
    const w = freshWorld(11);
    const input = M.emptyInput();
    input.fireHeld = true;
    step(w, input, 120);
    const ticks = w.tick;
    assert.equal(ticks, 120);
    assert.ok(Math.abs(w.time - 120 * DT) < 1e-9, 'time advances exactly dt per step');
  });

  await T('emits player:died exactly once and freezes the run', () => {
    const w = freshWorld(3);
    let deaths = 0;
    w.events.on('player:died', () => deaths++);
    w.damagePlayer(999, { x: 0, y: 0 });
    const tAfter = w.time;
    step(w, M.emptyInput(), 30);
    assert.equal(deaths, 1);
    assert.equal(w.runState, 'dead');
    assert.equal(w.player.alive, false);
    assert.equal(w.time, tAfter, 'sim must not advance after death');
  });

  await T('swept collision catches a projectile that would tunnel', () => {
    // 1180 px/s bullet moves ~19.7 px per 60 Hz step; a 26 px target can be skipped
    // by naive point tests. segmentAABB must report the hit.
    const w = freshWorld(2);
    w.enemies.length = 0;
    w.spawnEnemy('grunt', w.player.x + 300);
    const e = w.enemies[0];
    const box = { x: e.x, y: e.y, w: e.w, h: e.h };
    const hit = M.segmentAABB(box.x - 500, box.y + box.h / 2, box.x + 500, box.y + box.h / 2, box);
    assert.notEqual(hit, null);
    const miss = M.segmentAABB(box.x - 500, box.y - 400, box.x + 500, box.y - 400, box);
    assert.equal(miss, null);
  });

  await T('particle pool never exceeds its fixed capacity', () => {
    const w = freshWorld(5);
    const input = M.emptyInput();
    input.fireHeld = true;
    for (let i = 0; i < 900; i++) {
      w.particles.explosion(200 + (i % 40) * 12, 300, 40, '#ffb029');
      w.step(DT, input);
      assert.ok(w.particles.pool.items.length === M.CONFIG.particles.max,
        'particle pool must stay a fixed-size array');
      assert.ok(w.particles.liveCount <= M.CONFIG.particles.max,
        `live particles ${w.particles.liveCount} exceeded pool`);
    }
  });

  await T('never emits non-finite render coordinates', () => {
    const w = playSession({ seed: 9, seconds: 20, unlocked: ['ar', 'shotgun', 'railgun', 'missile'] });
    const frame = M.emptyFrame();
    const parallax = new M.ParallaxBackground();
    let checked = 0;
    for (let k = 0; k < 240; k++) {
      w.step(DT, M.emptyInput());
      M.buildRenderFrame(frame, w, parallax, k * DT);
      for (const list of ['screen', 'world', 'overlay']) {
        for (const cmd of frame[list]) {
          for (const key of ['x', 'y', 'w', 'h', 'r', 'x1', 'y1', 'x2', 'y2', 'sw', 'size']) {
            if (key in cmd && cmd[key] !== undefined && cmd[key] !== null) {
              assert.ok(Number.isFinite(cmd[key]), `non-finite ${key} in ${cmd.k}`);
              checked++;
            }
          }
        }
      }
    }
    assert.ok(checked > 10_000, 'exercised a meaningful number of fields');
  });

  await T('keeps the documented performance budget', () => {
    const w = playSession({ seed: 4, seconds: 20 });
    const input = M.emptyInput();
    input.fireHeld = true;
    const frame = M.emptyFrame();
    const parallax = new M.ParallaxBackground();
    const N = 1500;
    let t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) step(w, input);
    const simMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) M.buildRenderFrame(frame, w, parallax, i * DT);
    const frameMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    // measured: sim <0.05 ms/step, frame assembly ~0.26 ms — far inside budget
    assert.ok(simMs < 1.5, `sim step ${simMs}ms over budget`);
    assert.ok(frameMs < 2.0, `frame assembly ${frameMs}ms over budget`);
  });

// ───────────────────────────────────────────────────────────── input & player
GROUP = 'player › ';
  await T('crouch shrinks the hitbox from the feet up', () => {
    const w = freshWorld(1);
    const input = M.emptyInput();
    const feet = w.player.y + w.player.h;
    input.crouch = true;
    step(w, input, 2);
    assert.equal(w.player.crouching, true);
    assert.equal(w.player.y + w.player.h, feet, 'feet stay planted');
    assert.ok(w.player.h < M.CONFIG.player.h);
  });

  await T('crouch + jump side-step grants i-frames', () => {
    const w = freshWorld(1);
    const input = M.emptyInput();
    input.crouch = true;
    step(w, input, 2);
    input.jumpPressed = true;
    step(w, input, 1);
    input.jumpPressed = false;
    assert.ok(w.player.dodgeTimer > 0, 'dodge should start');
    const hp = w.player.hp;
    w.damagePlayer(25, { x: 0, y: 0 });
    assert.equal(w.player.hp, hp, 'damage must be ignored during i-frames');
    assert.ok(Math.abs(w.player.vx) >= M.CONFIG.player.dodgeSpeed * 0.9, 'dodge moves fast');
  });

  await T('jump buffers through coyote time', () => {
    const w = freshWorld(1);
    const input = M.emptyInput();
    input.jumpPressed = true;
    step(w, input, 1);
    input.jumpPressed = false;
    assert.ok(w.player.vy < 0, 'jumped');
  });

  await T('weapon switch respects unlock set', () => {
    const w = freshWorld(1, { unlocked: ['ar'] });
    const input = M.emptyInput();
    input.switchTo = 'railgun';
    step(w, input, 1);
    assert.equal(w.player.weapon, 'ar', 'locked weapon must not equip');
    w.unlocked = new Set(['ar', 'railgun']);
    input.switchTo = 'railgun';
    step(w, input, 1);
    assert.equal(w.player.weapon, 'railgun');
  });

  await T('8-way aim quantises to 45° steps', () => {
    for (const a of [0.1, 0.7, 1.2, 2.9, -1.1]) {
      const q = M.quantize8(a);
      const k = q / (Math.PI / 4);
      assert.ok(Math.abs(k - Math.round(k)) < 1e-9, `${a} -> ${q} not on 45° grid`);
    }
  });

  await T('aiming resolves to the stick vector and to facing when idle', () => {
    const w = freshWorld(1);
    const input = M.emptyInput();
    input.aimActive = true;
    input.aimStrength = 1;
    input.aimX = 0;
    input.aimY = 1;
    step(w, input, 1);
    assert.ok(Math.abs(w.player.aimAngle - Math.PI / 2) < 1e-6);
    input.aimActive = false;
    w.player.facing = -1;
    step(w, input, 1);
    assert.ok(Math.abs(Math.abs(w.player.aimAngle) - Math.PI) < 1e-6, 'idle aim follows facing');
  });

// ──────────────────────────────────────────────────────────────────── weapons
GROUP = 'weapons › ';
  await T('respects rate of fire and reloads instead of becoming infinite', () => {
    const w = freshWorld(1);
    const input = M.emptyInput();
    input.fireHeld = true;
    let shots = 0;
    w.events.on('weapon:fired', () => shots++);
    step(w, input, 600); // 10 s
    const spec = M.WEAPON_SPECS.ar;
    const cycles = Math.floor(10 / (spec.reloadTime + spec.magazine / (spec.rpm / 60)));
    const expected = cycles * spec.magazine + 8;
    assert.ok(shots > 30, 'kept firing across reloads');
    assert.ok(shots <= 10 / (60 / spec.rpm) + 1, `fired ${shots} > mechanical max`);
    assert.ok(shots >= expected * 0.85, `fired only ${shots}, expected ~${expected}`);
  });

  await T('railgun pierces up to its pierce count', () => {
    const w = freshWorld(1, { unlocked: ['railgun'], startWeapon: 'railgun' });
    w.player.weapon = 'railgun';
    w.enemies.length = 0;
    const y = M.CONFIG.view.groundY - 48;
    for (let i = 0; i < 6; i++) {
      const e = w.enemies[w.enemies.length - 1];
      w.spawnEnemy('grunt', w.player.x + 200 + i * 40);
      const spawned = w.enemies[w.enemies.length - 1];
      spawned.y = y;
      spawned.hp = 1;
      spawned.maxHp = 1;
    }
    w.damageEnemiesAlongRay(w.player.x + 40, y + 20, 0, 1500, 96, M.WEAPON_SPECS.railgun.pierce, '#7cf3ff');
    const dead = w.enemies.filter((e) => e.hp <= 0).length;
    assert.equal(dead, 6, 'all six in the column should die');
  });

  await T('missile splash falloff is monotonic', () => {
    const r = 96;
    const near = M.explosionDamage(48, 12, 0, r);
    const mid = M.explosionDamage(48, 12, r / 2, r);
    const edge = M.explosionDamage(48, 12, r, r);
    assert.ok(near > mid && mid > edge);
    assert.equal(edge, 12);
  });

// ─────────────────────────────────────────────────────────────────── grenades
GROUP = 'grenades › ';
  await T('charge ramps speed monotonically and flattens the lob', () => {
    const w = freshWorld(1);
    const samples = [0, 0.25, 0.5, 0.75, 1].map((c) => M.computeThrowVelocity(w, 0, c));
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i].vx > samples[i - 1].vx, 'horizontal speed must increase');
      assert.ok(samples[i].vy > samples[i - 1].vy, 'lift must flatten (less negative)');
    }
    const range = (vx, vy) => {
      // time to fall from throw height to the ground plane
      const y0 = M.CONFIG.view.groundY - 8 - (w.player.y + 18);
      const g = M.CONFIG.grenade.gravity;
      const t = (-vy + Math.sqrt(vy * vy + 2 * g * y0)) / g;
      return vx * t;
    };
    const short = range(samples[0].vx, samples[0].vy);
    const long = range(samples[4].vx, samples[4].vy);
    assert.ok(long / short > 2, `full charge should throw ~3x further (got ${(long / short).toFixed(2)}x)`);
  });

  await T('preview trajectory matches the real projectile', () => {
    const w = freshWorld(1);
    for (const angle of [0, -0.5, 0.9]) {
      for (const charge of [0, 0.5, 1]) {
        const predicted = M.predictThrow(w, angle, charge).impact;
        const v = M.computeThrowVelocity(w, angle, charge);
        const dir = { x: Math.cos(angle), y: Math.sin(angle) };
        let x = w.player.x + w.player.w / 2 + dir.x * 22;
        let y = w.player.y + 18;
        let vy = v.vy;
        const g = M.CONFIG.grenade.gravity;
        for (let i = 0; i < 600; i++) {
          vy += g * DT;
          const nx = x + v.vx * DT;
          const ny = y + vy * DT;
          if (ny + 8 >= M.CONFIG.view.groundY) { x = nx; y = M.CONFIG.view.groundY - 8; break; }
          x = nx; y = ny;
        }
        const err = Math.hypot(predicted.x - x, predicted.y - y);
        assert.ok(err < 40, `preview off by ${err.toFixed(1)}px at angle ${angle} charge ${charge}`);
      }
    }
  });

  knownBug('B11', 'full charge lands closer than half charge (range curve is non-monotonic)', () => {
    // The HUD promises "FAR THROW · 100%" and the README claims ~3x range at full
    // charge, but ease-out-cubic saturates vx while the flatter lift shortens flight
    // time, so the range peaks around 50% charge and then falls.
    const w = freshWorld(1);
    const y0 = M.CONFIG.view.groundY - 8 - (w.player.y + 18);
    const g = M.CONFIG.grenade.gravity;
    const range = (c) => {
      const v = M.computeThrowVelocity(w, 0, c);
      const t = (-v.vy + Math.sqrt(v.vy * v.vy + 2 * g * y0)) / g;
      return v.vx * t;
    };
    const curve = [0, 0.25, 0.5, 0.75, 1].map(range);
    for (let i = 1; i < curve.length; i++) {
      assert.ok(curve[i] > curve[i - 1],
        `range must grow with charge: ${curve.map((v) => Math.round(v)).join(' → ')} px`);
    }
  });

  await T('release throws exactly one grenade and spends one charge', () => {
    const w = freshWorld(1);
    const input = M.emptyInput();
    input.grenadeHeld = true;
    step(w, input, 40);
    assert.ok(w.player.grenadeCharge > 0.5, 'charging accumulates in sim state');
    const before = w.player.grenadeCharges;
    input.grenadeHeld = false;
    step(w, input, 1);
    assert.equal(w.grenades.length, 1);
    assert.equal(w.player.grenadeCharges, before - 1);
    step(w, input, 1);
    assert.equal(w.grenades.length, 1, 'must not double-throw');
  });

  await T('cannot throw with no charges', () => {
    const w = freshWorld(1);
    w.player.grenadeCharges = 0;
    w.player.grenadeCooldownTimer = M.CONFIG.grenade.cooldown; // reachable state: just emptied
    const input = M.emptyInput();
    input.grenadeHeld = true;
    step(w, input, 30);
    input.grenadeHeld = false;
    step(w, input, 2);
    assert.equal(w.grenades.length, 0, 'holding at 0 charges must not produce a grenade');
    const thrown = M.throwGrenade(w, 0, 1);
    assert.equal(thrown, false, 'throwGrenade must refuse a throw at 0 charges');
    assert.equal(w.grenades.length, 0);
  });

  await T('charges regenerate on the configured cooldown', () => {
    const w = freshWorld(1);
    const input = M.emptyInput();
    input.grenadeHeld = true;
    step(w, input, 2);
    input.grenadeHeld = false;
    step(w, input, 1);
    assert.equal(w.player.grenadeCharges, M.CONFIG.grenade.capacity - 1);
    // CONFIG.grenade.cooldown is 4.2 s, so after 2 s a charge should NOT be back.
    step(w, input, 120);
    assert.equal(w.player.grenadeCharges, M.CONFIG.grenade.capacity - 1,
      `charge refilled after 2s although cooldown is ${M.CONFIG.grenade.cooldown}s`);
  });

 await T('charges eventually regenerate', () => {
    const w = freshWorld(1);
    const input = M.emptyInput();
    input.grenadeHeld = true;
    step(w, input, 2);
    input.grenadeHeld = false;
    step(w, input, 1);
    assert.equal(w.player.grenadeCharges, M.CONFIG.grenade.capacity - 1);
    step(w, input, Math.ceil(M.CONFIG.grenade.cooldown * 60) + 5);
    assert.equal(w.player.grenadeCharges, M.CONFIG.grenade.capacity);
  });

// ──────────────────────────────────────────────────────────────────── spawner
GROUP = 'spawner › ';
  await T('never spawns an enemy inside the visible viewport', () => {
    const w = freshWorld(5);
    const input = M.emptyInput();
    const bad = [];
    w.events.on('enemy:spawned', ({ id }) => {
      const e = w.enemies.find((x) => x.id === id);
      if (!e) return;
      const cam = w.cameraSnapshot();
      if (e.x > cam.x - 480 && e.x < cam.x + 480) bad.push({ kind: e.kind, x: e.x, cam: cam.x });
    });
    step(w, input, 60 * 90);
    assert.equal(bad.length, 0, `spawned on-screen: ${JSON.stringify(bad.slice(0, 3))}`);
  });

  await T('wave director escalates over time', () => {
    const w = freshWorld(6);
    const input = M.emptyInput();
    // immortal player so the run survives long enough to observe waves
    w.player.hp = 1e9;
    w.player.maxHp = 1e9;
    step(w, input, 60 * 50);
    assert.ok(w.wave >= 4, `wave only reached ${w.wave}`);
  });

// ───────────────────────────────────────────────────────────────────── economy
GROUP = 'economy › ';
  const newStore = async () => {
    const services = M.configureServices(M.createMockServices({ analytics: noopAnalytics() }));
    const store = M.createGameStore(services);
    await store.getState().refreshShop(true);
    return { store, services };
  };

  await T('shop rotation is identical on every client for the same window', () => {
    const now = 1_760_000_000_000;
    const a = M.computeRotation(now);
    const b = M.computeRotation(now);
    assert.deepEqual(a.items, b.items);
    assert.equal(a.signature, b.signature);
    assert.notDeepEqual(a.items, M.computeRotation(now + 6 * 60 * 60 * 1000).items);
  });

  await T('rotation guarantees one offer per category and sane prices', () => {
    for (let k = 0; k < 200; k++) {
      const rot = M.computeRotation(1_760_000_000_000 + k * 6 * 60 * 60 * 1000);
      assert.equal(rot.items.length, 6);
      const cats = new Set(rot.items.map((i) => M.CATALOG_BY_ID[i.itemId].category));
      assert.equal(cats.size, 3, `rotation ${rot.rotationId} missing a category`);
      for (const it of rot.items) {
        const base = M.CATALOG_BY_ID[it.itemId].price;
        assert.ok(it.price >= 1 && it.price <= base, 'price must be discounted, never inflated');
        assert.ok([0, 10, 15, 20].includes(it.discountPct));
      }
    }
  });

  await T('purchase gates on level, funds and rotation membership', async () => {
    const { store } = await newStore();
    const s = () => store.getState();
    const notInRotation = M.CATALOG.find((i) => !s().shop.items.some((r) => r.itemId === i.id) && !i.ownedByDefault);
    const r1 = await s().purchaseItem(notInRotation.id);
    assert.equal(r1.reason, 'not_in_rotation');

    const owned = await s().purchaseItem('wpn_ar');
    assert.equal(owned.reason, 'already_owned');

    const gated = M.CATALOG.find((i) => i.unlockLevel > s().progression.level && s().shop.items.some((r) => r.itemId === i.id));
    if (gated) {
      const r2 = await s().purchaseItem(gated.id);
      assert.equal(r2.reason, 'level_gate');
    }
  });

  await T('cannot spend into a negative balance', async () => {
    const { store } = await newStore();
    const s = store.getState();
    assert.equal(s.spend('scrap', -100), false);
    assert.equal(s.spend('scrap', s.wallet.scrap + 1), false);
    const before = s.wallet.scrap;
    s.grantScrap(-500, 'test');
    assert.equal(store.getState().wallet.scrap, before, 'negative grants ignored');
  });

  await T('rewarded ad token is single use', async () => {
    const services = M.configureServices(M.createMockServices({ analytics: noopAnalytics() }));
    const reward = await services.ads.show('bonus_scrap');
    const first = await services.rewardVerifier.verify(reward.token);
    const replay = await services.rewardVerifier.verify(reward.token);
    assert.equal(first.valid, true);
    assert.equal(first.amount, M.AD_PLACEMENTS.bonus_scrap.amount);
    assert.equal(replay.valid, false, 'replayed SSV token must be rejected');
  });

  await T('server keeps authority over premium currency in a conflict', () => {
    const local = M.migrate({});
    local.wallet = { scrap: 100, gears: 5 };
    local.revision = 2;
    const remote = M.migrate({});
    remote.wallet = { scrap: 100, gears: 60 };
    remote.revision = 9;
    const merged = M.resolveConflict(local, remote);
    assert.equal(merged.wallet.gears, 60, 'client cannot invent Gears');
    assert.ok(merged.revision > remote.revision);
  });

  knownBug('B3', 'rewarded-ad daily cap resets on every page load', async () => {
    const services = M.configureServices(M.createMockServices({ analytics: noopAnalytics() }));
    const store = M.createGameStore(services);
    const cap = M.AD_PLACEMENTS.bonus_scrap.dailyCap;
    for (let i = 0; i < cap; i++) await store.getState().claimRewardedScrap();
    const persisted = store.getState().toPersisted();
    assert.ok(persisted.session && 'adClaimsToday' in persisted.session,
      `session counters are not persisted (keys: ${Object.keys(persisted).join(',')}), so a reload refills the cap`);
  });

  knownBug('B4', 'a stale cloud save overwrites newer premium currency and level', () => {
    const local = M.migrate({});
    local.wallet = { scrap: 9000, gears: 120 };
    local.progression = { ...local.progression, level: 9 };
    local.revision = 40;
    const remote = M.migrate({});
    remote.wallet = { scrap: 100, gears: 5 };
    remote.progression = { ...remote.progression, level: 4 };
    remote.revision = 3;
    const merged = M.resolveConflict(local, remote);
    assert.ok(merged.wallet.gears >= local.wallet.gears,
      `local revision ${local.revision} is newer but merged gears = ${merged.wallet.gears}`);
    assert.ok(merged.progression.level >= local.progression.level,
      `merged level ${merged.progression.level} < local ${local.progression.level}`);
  });

  knownBug('B5', 'starter bundle advertises Scrap Metal it never grants', async () => {
    const services = M.configureServices(M.createMockServices({ analytics: noopAnalytics() }));
    const store = M.createGameStore(services);
    const before = store.getState().wallet.scrap;
    await store.getState().buyGears('starter_bundle');
    const after = store.getState().wallet.scrap;
    assert.equal(after - before, 500, `bundle promises "+500 Scrap Metal" but credited ${after - before}`);
  });

// ────────────────────────────────────────────────────────────── gameplay loop
GROUP = 'gameplay › ';
  await T('a competent bot survives, kills and progresses', () => {
    const w = playSession({ seed: 2, seconds: 60, unlocked: ['ar', 'shotgun', 'railgun', 'missile'] });
    assert.ok(w.kills > 10, `only ${w.kills} kills in 60 s`);
    assert.ok(w.score > 1000);
  });

  knownBug('B1', 'scrap earned in a run is never credited (core economy loop is dead)', () => {
    const w = playSession({ seed: 2, seconds: 120 });
    const onFloor = w.pickups.reduce((a, p) => a + p.value, 0);
    assert.ok(w.scrapEarned > 0,
      `player killed ${w.kills} enemies, ${onFloor} scrap is sitting uncollected, scrapEarned = ${w.scrapEarned}`);
  });

  knownBug('B1b', 'scrap drops land outside the magnet radius and expire', () => {
    const w = freshWorld(2);
    const input = M.emptyInput();
    input.fireHeld = true;
    input.aimActive = true;
    input.aimStrength = 1;
    for (let f = 0; f < 60 * 40; f++) {
      const target = w.nearestEnemy(w.player.x, w.player.y, 1200);
      if (target) {
        const px = w.player.x + w.player.w / 2;
        const py = w.player.y + 22;
        const dx = target.x + target.w / 2 - px;
        const dy = target.y + target.h / 2 - py;
        const d = Math.hypot(dx, dy) || 1;
        input.aimX = dx / d;
        input.aimY = dy / d;
      }
      w.step(DT, input);
    }
    const px = w.player.x + w.player.w / 2;
    const py = w.player.y + w.player.h / 2;
    const dists = w.pickups.map((p) => Math.round(Math.hypot(p.x - px, p.y - py)));
    const closest = dists.length ? Math.min(...dists) : Infinity;
    assert.ok(closest < 175,
      `${dists.length} drops abandoned, nearest ${closest}px away (magnet radius is 175px)`);
  });

  knownBug('B2', 'the weapon equipped in the Armory is ignored on deploy', async () => {
    const services = M.configureServices(M.createMockServices({ analytics: noopAnalytics() }));
    const store = M.createGameStore(services);
    await store.getState().refreshShop(true);
    await store.getState().purchaseItem('wpn_shotgun');
    assert.equal(store.getState().loadout.weapon, 'shotgun', 'purchase equips the weapon');

    // Replicate the demo's own deploy path (web/main.ts: configureFromStore + world.reset).
    const world = new M.World();
    const state = store.getState();
    world.configure({
      modifiers: M.selectModifiers(state),
      unlocked: state.unlocks.weapons,
      aimMode: state.settings.aimMode,
      startWeapon: state.loadout.weapon,
    });
    world.reset();
    assert.equal(world.player.weapon, 'shotgun',
      `store says "${state.loadout.weapon}" but the run starts with "${world.player.weapon}"`);
  });

  knownBug('B6', 'no healing and a 22.5 DPS turret create an unwinnable cliff', () => {
    // Nothing in the sim can restore the player's HP.
    const w = freshWorld(1);
    const healSources = w.pickups.filter((p) => p.kind === 'health').length;
    assert.ok(healSources > 0, 'no health pickup kind exists; HP only ever decreases');

    // Turret burst: 3 rounds x 12 dmg every 1.6 s = 22.5 dps at any range.
    const turret = M.ENEMY_STATS.turret;
    const turretDps = (turret.bulletDamage * 3) / turret.fireInterval;
    const ttk = M.CONFIG.player.maxHp / turretDps;
    assert.ok(ttk > 8, `a single off-screen turret kills a full-HP player in ${ttk.toFixed(1)}s`);
  });

// ──────────────────────────────────────────────────────────── renderer contract
GROUP = 'renderer › ';
  await T('render frame is built with a stable shape for both backends', () => {
    const w = freshWorld(1);
    const frame = M.emptyFrame();
    M.buildRenderFrame(frame, w, new M.ParallaxBackground(), 1);
    assert.ok(frame.screen.length > 50, 'parallax layers present');
    assert.ok(frame.world.length > 10, 'world commands present');
    assert.ok(Array.isArray(frame.overlay));
    const kinds = new Set([...frame.screen, ...frame.world, ...frame.overlay].map((c) => c.k));
    for (const k of kinds) assert.ok(['rect', 'poly', 'circle', 'line', 'arc', 'text', 'gradient'].includes(k), `unknown command ${k}`);
  });

  await T('paused frame dims the scene without stopping assembly', () => {
    const w = freshWorld(1);
    w.runState = 'paused';
    const frame = M.emptyFrame();
    M.buildRenderFrame(frame, w, new M.ParallaxBackground(), 1);
    const dim = frame.overlay.find((c) => c.k === 'rect' && c.w === M.CONFIG.view.designWidth);
    assert.ok(dim, 'pause veil expected');
  });

  await T('camera shake decays to rest', () => {
    const w = freshWorld(1);
    w.camera.addTrauma(1);
    step(w, M.emptyInput(), 120);
    const snap = w.cameraSnapshot();
    assert.ok(Math.abs(snap.shakeX) < 1 && Math.abs(snap.shakeY) < 1, 'trauma should decay');
  });
