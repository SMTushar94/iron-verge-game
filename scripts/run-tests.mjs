#!/usr/bin/env node
/**
 * Runs the IRON VERGE engine test suite against the shipped single-file demo.
 *
 *  1. regenerates build/engine.generated.mjs from IRON-VERGE-playable-demo.html
 *  2. executes tests/*.test.mjs with node:test
 *
 * Usage: npm test  ·  npm test -- --summary
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const extract = spawnSync(process.execPath, [resolve(root, 'scripts/extract-engine.mjs')], { stdio: 'inherit' });
if (extract.status !== 0) process.exit(extract.status ?? 1);

const files = readdirSync(resolve(root, 'tests'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => resolve(root, 'tests', f));

const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit', cwd: root });
process.exit(run.status ?? 1);
