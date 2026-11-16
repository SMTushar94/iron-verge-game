#!/usr/bin/env node
/**
 * Drives a scripted play session headlessly and dumps the real RenderFrame
 * command buffers to JSON, so `scripts/rasterize-frames.py` can turn them into
 * PNGs. This is the stand-in for browser screenshots in a headless sandbox.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import M from '../build/engine.generated.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'build/snapshots');
mkdirSync(outDir, { recursive: true });

const dt = 1 / 60;
const frame = M.emptyFrame();
const parallax = new M.ParallaxBackground();

function dump(w, name, time) {
  M.buildRenderFrame(frame, w, parallax, time);
  return {
    name,
    camera: w.cameraSnapshot(),
    screen: frame.screen.map((c) => ({ ...c })),
    world: frame.world.map((c) => ({ ...c })),
    overlay: frame.overlay.map((c) => ({ ...c })),
    stats: { time: w.time, hp: w.player.hp, enemies: w.enemies.length, score: w.score, kills: w.kills },
  };
}

const shots = [];
const world = new M.World();
world.reset(20260316);
world.configure({ unlocked: ['ar', 'shotgun', 'railgun', 'missile'], aimMode: 'free', startWeapon: 'ar' });
world.reset(20260316);

const input = new M.InputAdapter();
input.setAim(1, -0.12, true);

// -- 1. opening second: spawn-in, parallax, ground
let t = 0;
for (let i = 0; i < 90; i++) { world.step(dt, input.snapshot()); input.consumeEdges(); t += dt; }
shots.push(dump(world, '01-opening', t));

// -- 2. sustained firefight: kill things, build combo, then snap
const aimTargets = [];
for (let i = 0; i < 60 * 26; i++) {
  const target = world.nearestEnemy(world.player.x, world.player.y, 900);
  if (target) {
    const px = world.player.x + world.player.w / 2;
    const py = world.player.y + 22;
    input.setAim(target.x + target.w / 2 - px, target.y + target.h / 2 - py, true);
  }
  input.setFire(true);
  if (i % 420 === 200) input.pressWeapon('shotgun');
  if (i % 420 === 340) input.pressWeapon('ar');
  if (i % 260 === 120) input.setGrenade(true);
  if (i % 260 === 190) input.setGrenade(false);
  world.step(dt, input.snapshot());
  input.consumeEdges();
  t += dt;
  if (world.player.hp <= 0) break;
}
shots.push(dump(world, '02-firefight', t));

// -- 3. mid-charge grenade with trajectory preview
const w2 = new M.World();
w2.reset(4242);
let t2 = 0;
for (let i = 0; i < 60 * 8; i++) { w2.step(dt, input.snapshot()); input.consumeEdges(); t2 += dt; }
const gIn = new M.InputAdapter();
gIn.setAim(Math.cos(-0.55), Math.sin(-0.55), true);
gIn.setGrenade(true);
for (let i = 0; i < 45; i++) { w2.step(dt, gIn.snapshot()); gIn.consumeEdges(); t2 += dt; }
shots.push(dump(w2, '03-grenade-charge', t2));

// -- 4. explosion frame
gIn.setGrenade(false);
for (let i = 0; i < 30; i++) { w2.step(dt, gIn.snapshot()); gIn.consumeEdges(); t2 += dt; }
for (let i = 0; i < 90; i++) { w2.step(dt, gIn.snapshot()); gIn.consumeEdges(); t2 += dt; }
shots.push(dump(w2, '04-grenade-blast', t2));

// -- 5. pause overlay
w2.runState = 'paused';
shots.push(dump(w2, '05-paused', t2));

writeFileSync(resolve(outDir, 'frames.json'), JSON.stringify(shots));
console.log(`wrote ${shots.length} frames -> build/snapshots/frames.json`);
for (const s of shots) console.log(`  ${s.name}: t=${s.stats.time.toFixed(1)}s hp=${s.stats.hp} kills=${s.stats.kills} enemies=${s.stats.enemies} cmds=${s.screen.length + s.world.length + s.overlay.length}`);
