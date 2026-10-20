#!/usr/bin/env node
/* =============================================================================
   AC-4 · 站外引用扫描（NFR-9：无任何外部请求）
   扫 index.html / css / js 里的 http(s) 地址，只允许本项目自己的域名。
   用法：node tools/check-links.mjs
   ========================================================================== */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALLOW = [
  /^https?:\/\/github\.com\/HH200606\/neon-serpent(?:[/#?]|$)/i,
  /^https?:\/\/hh200606\.github\.io\/neon-serpent(?:[/#?]|$)/i,
  // SVG 的 XML 命名空间，只是字符串标识，浏览器不会发起请求
  /^http:\/\/www\.w3\.org\/2000\/svg$/i,
];

function files(dir, exts, out = []) {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) files(rel, exts, out);
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(rel);
  }
  return out;
}

const targets = ['index.html', ...files('css', ['.css']), ...files('js', ['.js'])];
const URL_RE = /https?:\/\/[^\s"'<>()]+/gi;

const findings = [];
for (const rel of targets) {
  const text = readFileSync(path.join(ROOT, rel), 'utf8');
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    if (ALLOW.some((re) => re.test(url))) continue;
    const line = text.slice(0, match.index).split('\n').length;
    findings.push({ file: rel, line, url });
  }
}

if (findings.length) {
  console.error('FAIL: 发现站外引用（NFR-9 / AC-4）');
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.url}`);
  process.exit(1);
}

console.log(`PASS: ${targets.length} 个文件里没有站外引用（AC-4）`);
