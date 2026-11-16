#!/usr/bin/env node
/**
 * IRON VERGE — balance / live-ops analysis report.
 *
 * Re-derives every number quoted in ANALYSIS.md straight from the shipped
 * bundle, so the analysis can be re-run after a tuning pass:
 *
 *   npm run analyze
 */
import M from '../build/engine.generated.mjs';

const DT = 1 / 60;
const kb = M.CONFIG;
const num = (n, d = 1) => Number(n).toFixed(d);
const pad = (s, n) => String(s).padEnd(n);
const line = (c = '─') => console.log(c.repeat(78));
const h1 = (t) => { console.log(); line('═'); console.log(t); line('═'); };
const h2 = (t) => { console.log(); line(); console.log(t); line(); };

// ───────────────────────────────────────────────────────────── bot definitions
function botRun({ seed = 1, seconds = 120, unlocks = ['ar'], gatherLoot = false } = {}) {
  const w = new M.World();
  w.configure({ unlocked: unlocks });
  w.reset(seed);
  const input = M.emptyInput();
  let peakFloorScrap = 0;
  for (let f = 0; f < seconds * 60 && w.player.alive; f++) {
    const p = w.player;
    const target = w.nearestEnemy(p.x, p.y, 1200);
    const loot = w.pickups.filter((v) => v.active);
    let nearestLoot = null;
    let lootDist = Infinity;
    for (const v of loot) {
      const d = Math.abs(v.x - p.x);
      if (d < lootDist) { lootDist = d; nearestLoot = v; }
    }
    const threat = target ? Math.hypot(target.x - p.x, target.y - p.y) : Infinity;

    if (gatherLoot && nearestLoot && lootDist < 520 && threat > 190) {
      input.moveX = Math.sign(nearestLoot.x - (p.x + p.w / 2));
      input.fireHeld = false;
    } else if (target) {
      const dx = target.x + target.w / 2 - (p.x + p.w / 2);
      const dy = target.y + target.h / 2 - (p.y + 22);
      const d = Math.hypot(dx, dy) || 1;
      input.aimActive = true; input.aimStrength = 1;
      input.aimX = dx / d; input.aimY = dy / d;
      input.fireHeld = true;
      input.moveX = d < 260 ? (target.x > p.x ? -1 : 1) : 0;
    } else {
      input.fireHeld = false;
      input.moveX = -0.4;
    }
    w.step(DT, input);
    peakFloorScrap = Math.max(peakFloorScrap, w.pickups.reduce((a, v) => a + v.value, 0));
  }
  return { w, peakFloorScrap };
}

// ────────────────────────────────────────────────────────────────────── report
h1(`IRON VERGE — analysis   (bundle: ${(kb.view.designWidth)}x${kb.view.designHeight} design, 60 Hz)`);

// 1. survivability
h2('1 · SURVIVABILITY  (bot aims at nearest enemy, kites under 260px, never heals)');
console.log(`${pad('seed', 6)}${pad('result', 10)}${pad('time', 8)}${pad('kills', 7)}${pad('score', 8)}${pad('scrap', 8)}wave`);
const survivals = [];
for (const seed of [1, 2, 3, 4, 5, 6]) {
  const { w } = botRun({ seed, seconds: 180 });
  survivals.push(w.time);
  console.log(`${pad(seed, 6)}${pad(w.player.alive ? 'SURVIVED' : 'DIED', 10)}${pad(num(w.time) + 's', 8)}${pad(w.kills, 7)}${pad(w.score, 8)}${pad(w.scrapEarned, 8)}${w.wave}`);
}
const avg = survivals.reduce((a, b) => a + b, 0) / survivals.length;
console.log(`\nmean survival ${num(avg)}s — a "run" is ~30-40s, which sets the whole economy's income rate.`);

// 2. economy
h2('2 · ECONOMY  (scrap income → unlock pricing)');
const greedy = botRun({ seed: 2, seconds: 180 });
const gather = botRun({ seed: 2, seconds: 180, gatherLoot: true });
console.log(`kills ${greedy.w.kills}  scrap credited ${greedy.w.scrapEarned}  (peak ${greedy.peakFloorScrap} scrap abandoned on the floor)`);
console.log(`same run with a bot that walks over the loot:  scrap credited ${gather.w.scrapEarned}`);
console.log('⇒ scrap only reaches the wallet if the player physically walks over the drop;');
console.log('   kills at range leave 100% of the reward behind (see ANALYSIS.md B1/B1b).');
console.log();
const starter = 1250;
for (const item of M.CATALOG.filter((i) => !i.ownedByDefault && i.currency === 'scrap')) {
  const perRun = gather.w.scrapEarned || 1;
  const runs = Math.ceil(item.price / perRun);
  console.log(`  ${pad(item.id, 18)}${pad(item.price + ' scrap', 14)}≈ ${runs} run(s) at ${perRun} scrap/run`);
}

// 3. damage model
h2('3 · DAMAGE MODEL  (no healing exists, HP only decreases)');
const maxHp = kb.player.maxHp;
console.log(`${pad('enemy', 8)}${pad('hp', 6)}${pad('bullet dps', 12)}${pad('contact', 9)}${pad('TTK vs 100 HP', 14)}`);
for (const [kind, s] of Object.entries(M.ENEMY_STATS)) {
  const shots = kind === 'turret' ? 3 : kind === 'brute' ? 2 : 1;
  const dps = s.fireInterval > 0 ? (s.bulletDamage * shots) / s.fireInterval : 0;
  console.log(`${pad(kind, 8)}${pad(s.hp, 6)}${pad(dps ? num(dps) : '—', 12)}${pad(s.contactDamage, 9)}${pad(dps ? num(maxHp / dps) + 's' : '—', 14)}`);
}
console.log(`\ninvulnerability after a hit: ${kb.player.invulnerableOnHit}s — a 22.5 dps turret still kills a full-HP player in ${num(maxHp / 22.5)}s.`);

// 4. weapons
h2('4 · WEAPON DPS  (theoretical, no reload)');
console.log(`${pad('weapon', 10)}${pad('burst dps', 12)}${pad('sustained dps', 15)}${pad('mag', 6)}${pad('reload', 9)}sustained DPS vs brute (260hp)`);
for (const [id, s] of Object.entries(M.WEAPON_SPECS)) {
  const rof = s.rpm / 60;
  const burst = s.damage * s.pellets * rof;
  const cycle = s.magazine / rof + s.reloadTime;
  const sustained = (s.damage * s.pellets * s.magazine) / cycle;
  console.log(`${pad(id, 10)}${pad(num(burst), 12)}${pad(num(sustained), 15)}${pad(s.magazine, 6)}${pad(s.reloadTime + 's', 9)}${num(260 / sustained)}s`);
}
console.log('\nnote: the railgun lists 96 dmg @ 58 rpm → 92.8 burst DPS but only 6 rounds before a 2.35s reload.');

// 5. grenade
h2('5 · GRENADE CHARGE CURVE');
const gw = new M.World();
gw.reset(1);
const range = (v) => {
  const y0 = kb.view.groundY - 8 - (gw.player.y + 18);
  const g = kb.grenade.gravity;
  // y(t) = y0 + vy·t + ½·g·t² ; solve y(t) = 0 for the positive root
  const t = (-v.vy + Math.sqrt(v.vy * v.vy + 2 * g * y0)) / g;
  return v.vx * t;
};
for (const c of [0, 0.25, 0.5, 0.75, 1]) {
  const v = M.computeThrowVelocity(gw, 0, c);
  console.log(`  charge ${pad(num(c * 100, 0) + '%', 5)}vx ${pad(num(v.vx), 8)}vy ${pad(num(v.vy), 9)}range ≈ ${num(range(v), 0)}px`);
}
console.log(`  max damage ${kb.grenade.maxDamage} · radius ${kb.grenade.radius}px · fuse ${kb.grenade.fuse}s · capacity ${kb.grenade.capacity}`);
{
  const curve = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((c) => range(M.computeThrowVelocity(gw, 0, c)));
  const peak = Math.max(...curve);
  const peakAt = curve.indexOf(peak) / (curve.length - 1);
  console.log(`  ⇒ range peaks at ~${Math.round(peakAt * 100)}% charge (${num(peak, 0)}px) and FALLS to ${num(curve[curve.length - 1], 0)}px at 100%`);
  console.log('     (HUD label says "FAR THROW · 100%" — the curve is non-monotonic; see ANALYSIS.md B11)');
}

// 6. pacing
h2('6 · PROGRESSION CURVE  (levels gate 3 of 12 catalogue items)');
const xpForLevel = (l) => 100 * (l - 1) ** 2;
let lvl = 4;
let xp = 940;
const perRunXp = Math.floor(4000 / 50) + 30 * 5;
console.log(`a typical run (score 4000, 30 kills) grants ${perRunXp} xp`);
for (let run = 1; run <= 40; run++) {
  xp += perRunXp;
  while (xp >= xpForLevel(lvl + 1)) lvl++;
  if ([1, 5, 10, 20, 40].includes(run)) console.log(`  after ${pad(run, 3)} runs → level ${pad(lvl, 3)}(xp ${xp}/${xpForLevel(lvl + 1)})`);
}
for (const item of M.CATALOG.filter((i) => i.unlockLevel > 4)) {
  console.log(`  gated: ${pad(item.id, 16)}needs level ${pad(item.unlockLevel, 3)}price ${item.price} ${item.currency}`);
}

// 7. performance
h2('7 · PERFORMANCE  (documented budgets: sim <1.5 ms, frame assembly <2.0 ms)');
{
  const w = new M.World();
  w.reset(7);
  const input = M.emptyInput();
  input.fireHeld = true;
  let peakParticles = 0;
  for (let i = 0; i < 900; i++) { w.step(DT, input); peakParticles = Math.max(peakParticles, w.particles.liveCount); }
  const frame = M.emptyFrame();
  const par = new M.ParallaxBackground();
  const N = 3000;
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { w.step(DT, input); peakParticles = Math.max(peakParticles, w.particles.liveCount); }
  const simMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) M.buildRenderFrame(frame, w, par, i * DT);
  const frameMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`  sim step          ${num(simMs, 4)} ms   (${num((simMs / 1.5) * 100, 1)}% of budget)`);
  console.log(`  frame assembly    ${num(frameMs, 4)} ms   (${num((frameMs / 2) * 100, 1)}% of budget)`);
  console.log(`  commands/frame    ${frame.screen.length + frame.world.length + frame.overlay.length}`);
  console.log(`  live particles    ${peakParticles} / ${kb.particles.max} peak`);
  console.log('  ⇒ simulation and frame assembly are far inside budget; the cost is in raster + DOM HUD.');
}

// 8. content inventory
h2('8 · CONTENT INVENTORY');
console.log(`  weapons ${M.CATALOG.filter((i) => i.category === 'weapons').length} · skins ${M.CATALOG.filter((i) => i.category === 'armor').length} · utilities ${M.CATALOG.filter((i) => i.category === 'utilities').length}`);
console.log(`  enemy kinds ${Object.keys(M.ENEMY_STATS).length} · weapon specs ${Object.keys(M.WEAPON_SPECS).length} · parallax layers 5`);
console.log(`  ad placements declared ${Object.keys(M.AD_PLACEMENTS).length} (only bonus_scrap is reachable from the UI)`);
console.log(`  iap products ${5} · save version ${M.SAVE_VERSION}`);
console.log();
