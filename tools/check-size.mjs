#!/usr/bin/env node
/* =============================================================================
   AC-2 · 首屏体积检查（NFR-3）
   html + css + js 字节和（不压缩、不含图片），阈值默认 60KB。
   用法：node tools/check-size.mjs [--max=61440] [--json]
   ========================================================================== */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 60 * 1024;

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);

const max = Number(args.get('max')) > 0 ? Number(args.get('max')) : LIMIT;

function files(dir, ext, out = []) {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) files(rel, ext, out);
    else if (entry.name.endsWith(ext)) out.push(rel);
  }
  return out;
}

const targets = ['index.html', ...files('css', '.css'), ...files('js', '.js')];
const rows = targets.map((rel) => ({ file: rel, bytes: statSync(path.join(ROOT, rel)).size }));
const total = rows.reduce((sum, r) => sum + r.bytes, 0);

if (args.has('json')) {
  console.log(JSON.stringify({ max, total, pass: total <= max, files: rows }, null, 2));
} else {
  for (const r of rows) {
    console.log(`${String(r.bytes).padStart(7)}  ${r.file}`);
  }
  console.log('-'.repeat(40));
  const kb = (total / 1024).toFixed(1);
  const limitKb = (max / 1024).toFixed(0);
  console.log(`${String(total).padStart(7)}  total (${kb}KB / ${limitKb}KB)`);
}

if (total > max) {
  console.error(`FAIL: 首屏 ${total} 字节，超过阈值 ${max}（NFR-3 / AC-2）`);
  process.exit(1);
}
console.log('PASS: 首屏体积在阈值内（AC-2）');
