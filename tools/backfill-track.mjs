#!/usr/bin/env node
/**
 * backfill-track.mjs — set Track on the historical rows that predate the column.
 *
 * ── Why this is a short list and not 242 rows ──
 * An empty Track means `ai-app`, and that is a TRUE STATEMENT about every row
 * written before 2026-10-10: the system ran a single direction then. So there is
 * nothing to backfill for the AI track — writing `ai-app` into 232 cells would
 * add no information and cost 232 writes.
 *
 * What IS worth labelling is the handful of automotive rows that went through the
 * pipeline before the second direction existed. They are all closed, so they will
 * never convert; their value is as denominator history in the per-track funnel.
 *
 * ── Why some automotive-looking rows are deliberately left blank ──
 * `auto-data` is defined as ADAS data-loop / data-platform work, and explicitly
 * NOT "a warehouse job that happens to be at a car company" — ordinary internet
 * or OEM warehousing is still a deal-breaker. So an OEM BI or plain big-data role
 * does not become `auto-data` just because the employer makes cars. Mislabelling
 * those would inflate the automotive denominator with roles the candidate would
 * not take, and quietly make the second direction look worse than it is.
 * Those rows stay blank and are listed below under "left blank, on purpose".
 *
 * Run: node tools/backfill-track.mjs            # dry-run, shows the plan
 *      node tools/backfill-track.mjs --apply    # writes via updateMany()
 */

import { readFileSync } from 'node:fs';
import { listApplications, updateMany, getBackend, normalizeTrack } from './tracker-backend.mjs';

// The row-by-row classification is personal application history, so it lives
// in a gitignored file, not here (this repo is public). Shape:
//   { "assign":     { "<num>": { "track": "<track_id>", "why": "<reason>" } },
//     "left_blank": { "<num>": "<why this automotive-employer row gets no track>" } }
const DATA_FILE = new URL('../config/track-backfill.json', import.meta.url);
let ASSIGN, LEFT_BLANK;
try {
  ({ assign: ASSIGN = {}, left_blank: LEFT_BLANK = {} } = JSON.parse(readFileSync(DATA_FILE, 'utf8')));
} catch (e) {
  console.error(`没有读到 config/track-backfill.json（${e.code || e.message}）。格式见本文件注释。`);
  process.exit(1);
}

const apply = process.argv.includes('--apply');

const apps = await listApplications();
const byNum = new Map(apps.map(a => [Number(a.num), a]));
const backend = await getBackend();

const pending = [];
const problems = [];

console.log('=== 计划写入 ===\n');
for (const [numStr, { track, why }] of Object.entries(ASSIGN)) {
  const num = Number(numStr);
  const row = byNum.get(num);
  if (!row) { problems.push(`#${num} tracker 里不存在`); continue; }

  normalizeTrack(track);   // throws early on a typo rather than at write time

  if (row.track === track) {
    console.log(`⏭  #${num} 已是 ${track}（${row.company}）`);
    continue;
  }
  if (row.track && row.track !== track) {
    problems.push(`#${num} 已有不同的 track "${row.track}"，不覆盖（想改请手动）`);
    continue;
  }
  pending.push({ num, track });
  console.log(`${apply ? '✅' : '🔍'} #${num} → ${track}`);
  console.log(`     ${row.company} — ${row.role}  [${row.status}]`);
  console.log(`     理由：${why}`);
}

console.log('\n=== 故意留空（车企雇主，但岗位不在任何汽车轨上）===\n');
for (const [numStr, why] of Object.entries(LEFT_BLANK)) {
  const row = byNum.get(Number(numStr));
  console.log(`   #${numStr} ${row ? `${row.company} — ${row.role}` : '(不在 tracker)'}`);
  console.log(`     ${why}`);
}

console.log(`\n=== 其余 ${apps.length - Object.keys(ASSIGN).length - Object.keys(LEFT_BLANK).length} 条 ===`);
console.log('   留空 = ai-app。这不是兜底，是对 2026-10-10 之前记录的事实陈述（当时只有一个方向）。\n');

if (problems.length) {
  console.log('⚠️  需要人工看一眼：');
  problems.forEach(p => console.log(`   ${p}`));
  console.log('');
}

if (!apply) {
  console.log(`dry-run，未写入。确认无误后：node tools/backfill-track.mjs --apply`);
  process.exit(0);
}

if (pending.length === 0) {
  console.log('没有需要写入的行。');
  process.exit(0);
}

// One table read + one batch write, not a loop of single updates.
const { updated, missing } = await updateMany(pending);
console.log(`📝 已写入 ${backend.backendName} 后端：${updated} 条`);
if (missing.length) console.log(`⚠️  未找到: ${missing.join(', ')}`);
if (backend.backendName === 'bitable') {
  console.log('   运行 `npm run tracker:export` 刷新 data/applications.md 快照');
}
