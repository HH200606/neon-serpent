#!/usr/bin/env node
/* =============================================================================
   PRD 结构完整性检查
   -----------------------------------------------------------------------------
   docs/PRD.md 曾被外部 Markdown 格式化工具重排过两次：frontmatter 的 --- 变成
   \---、<!--toc--> 被删、表格补满空格。后两种会让 Word 版静默丢目录/YAML。
   本脚本把这些"静默漂移"变成会失败的检查。
   用法：node tools/check-prd.mjs
   ========================================================================== */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs', 'PRD.md');

const text = readFileSync(SRC, 'utf8');
const lines = text.split('\n');
const problems = [];

if (lines[0].trim() !== '---') {
  problems.push(`第 1 行不是 YAML 起始 "---"（现在是 ${JSON.stringify(lines[0])}）`);
}

const closing = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
if (closing < 0) {
  problems.push('找不到 YAML frontmatter 的结束 "---"');
} else if (!lines.slice(0, closing).some((l) => l.startsWith('version:'))) {
  problems.push('frontmatter 里没有 version 字段');
}

if (text.includes('\\---')) {
  problems.push('出现了被转义的 \\---（Markdown 格式化工具会这样破坏 frontmatter）');
}

if (!text.includes('<!--toc-->')) {
  problems.push('缺少 <!--toc--> 标记：Word 版会静默没有目录');
}

const statusCells = [...text.matchAll(/^\|\s*(FR-[\d.]+|NFR-\d+|AC-\d+)\s*\|[^|]*\|[^|]*\|\s*([a-z-]+)\s*\|/gm)];
const ALLOWED = new Set(['implemented', 'partial', 'not-implemented', 'defect', 'waived']);
for (const match of statusCells) {
  if (!ALLOWED.has(match[2])) {
    problems.push(`${match[1]} 的状态值 ${JSON.stringify(match[2])} 不在状态枚举里`);
  }
}

if (problems.length) {
  console.error('FAIL: PRD 结构检查未通过');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log(`PASS: PRD 结构完整（frontmatter + toc 标记 + ${statusCells.length} 条状态值）`);
