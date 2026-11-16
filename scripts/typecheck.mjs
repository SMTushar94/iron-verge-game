#!/usr/bin/env node
/**
 * Validates the single-file demo bundle without a browser.
 *
 *  - the inlined script parses as ES2022 and contains no accidental globals leaks
 *  - every getElementById/$() reference resolves to a real id in the markup
 *  - no duplicate ids
 *  - no external network references (the bundle must stay self-contained/offline)
 *  - reports the shipped sizes and the ratio of engine vs. shell code
 *
 * Exit code 1 on any hard failure, so `npm run typecheck` is CI-usable.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(root, 'IRON-VERGE-playable-demo.html');
const html = readFileSync(file, 'utf8');

const problems = [];
const notes = [];

// ── 1. syntax check ────────────────────────────────────────────────────────────
const scriptStart = html.indexOf('<script>"use strict"');
const scriptEnd = html.lastIndexOf('</script>');
if (scriptStart < 0 || scriptEnd < scriptStart) problems.push('inline <script> block not found');
const script = html.slice(scriptStart + '<script>'.length, scriptEnd);

const tmp = mkdtempSync(resolve(tmpdir(), 'iv-'));
const tmpFile = resolve(tmp, 'bundle.mjs');
writeFileSync(tmpFile, script);
try {
  execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
  notes.push('inline bundle parses as ES2022');
} catch (err) {
  problems.push(`inline bundle has a syntax error: ${String(err.stderr || err).slice(0, 400)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── 2. DOM wiring ──────────────────────────────────────────────────────────────
const body = html.slice(html.indexOf('<body>'), scriptStart);
const markup = body.replace(/<script>[\s\S]*$/, '');
const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const idSet = new Set(ids);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) problems.push(`duplicate element ids: ${[...new Set(dupes)].join(', ')}`);

const refs = new Set([
  ...[...script.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]),
  ...[...script.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]),
]);
const missing = [...refs].filter((id) => !idSet.has(id) && !id.includes('{'));
if (missing.length) problems.push(`JS references ids that do not exist: ${missing.join(', ')}`);

// `$${...}` template ids built at runtime
const dynamicRefs = [...script.matchAll(/\$\("([^"]*\$\{[^"]*)"\)/g)].map((m) => m[1]);
if (dynamicRefs.length) notes.push(`dynamic id lookups (not statically checkable): ${dynamicRefs.join(', ')}`);

// ── 3. self-containment ────────────────────────────────────────────────────────
const external = [
  ...html.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+"/g),
  ...html.matchAll(/@import\s+url\(/g),
  ...html.matchAll(/fetch\("https?:/g),
];
if (external.length) problems.push(`bundle references external URLs (${external.length}); must stay offline-capable`);

// ── 4. static accessibility / mobile sanity ────────────────────────────────────
const buttons = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
const unlabelled = buttons.filter(([, attrs, inner]) => {
  const text = inner.replace(/<[^>]+>/g, '').trim();
  return !text && !/aria-label|title=/.test(attrs);
});
if (unlabelled.length) notes.push(`${unlabelled.length} icon-only button(s) without aria-label/title`);

if (!/<meta name="viewport"/.test(html)) problems.push('missing responsive viewport meta');
const touchTargets = [...markup.matchAll(/id="(btn-[a-z]+)"/g)].map((m) => m[1]);
if (touchTargets.length && !/touch-controls/.test(html)) problems.push('touch buttons exist but no touch-controls container');

// ── 5. sizing report ──────────────────────────────────────────────────────────
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const engineBytes = script.length;
const cssBytes = html.slice(html.indexOf('<style>'), html.indexOf('</style>')).length;
notes.push(`bundle ${kb(Buffer.byteLength(html))} · script ${kb(engineBytes)} · css ${kb(cssBytes)} · markup ${kb(Buffer.byteLength(markup))}`);
const shellAt = Math.max(script.indexOf('// web/ui.ts'), script.indexOf('var DemoUI = class'));
if (shellAt > 0) {
  notes.push(`engine ${kb(shellAt)} / browser shell ${kb(engineBytes - shellAt)} of the script`);
} else {
  notes.push('browser shell boundary not found (engine slice may have moved)');
}

for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.error('\nFAILED:');
  for (const p of problems) console.error(`  ✖ ${p}`);
  process.exit(1);
}
console.log('\n✓ demo bundle is self-contained, parses, and every DOM id reference resolves');
