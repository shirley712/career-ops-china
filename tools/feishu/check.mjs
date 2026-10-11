#!/usr/bin/env node
/**
 * check.mjs — `npm run feishu:check`. The one place to answer "is Feishu wired up?"
 *
 * Read-only. Never logs in, never writes, never prints a secret. Its whole job is
 * to tell you which of the three independent things is missing:
 *   1. config    — is the capability switched on in config/profile.yml?
 *   2. identity  — does that lark-cli profile resolve to a real logged-in user?
 *   3. scope     — does the token actually carry the domain the capability needs?
 *
 * They fail separately and the error messages look similar, which is why this
 * exists: `missing_scope` and "not logged in" are a wasted afternoon apart.
 */

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  KNOWN_CAPABILITIES, feishuConfig, healthCheck, resolveProfile,
  grantedScopes, missingScopes, CAPABILITY_SCOPES,
} from './capabilities.mjs';
import { readProfileTracker } from '../tracker-backend.mjs';

const CAREER_OPS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function tick(b) { return b ? '✅' : '❌'; }

async function main() {
  console.log('=== career-ops · Feishu 集成体检 ===\n');

  // 1. config
  const cfg = feishuConfig();
  const tracker = readProfileTracker();
  const report = healthCheck();

  console.log(`config/profile.yml:`);
  console.log(`  feishu.enabled        ${tick(cfg.enabled)} ${cfg.enabled}`);
  console.log(`  feishu.profile        ${tick(!!cfg.profile)} ${cfg.profile || '(未设置)'}`);
  console.log(`  tracker.backend       ${tracker.backend}`);
  console.log(`  tracker.bitable.profile ${tick(!!tracker.bitable?.profile)} ${tracker.bitable?.profile || '(未设置)'}`);
  console.log('');

  if (!cfg.enabled) {
    console.log('飞书总开关是关的 —— 这是合法状态，不是错误。');
    console.log('所有飞书动作会返回 {skipped:true}，提醒落到 data/reminders.md。');
    console.log('tracker 的 Bitable 后端不受这个开关影响（由 tracker.backend 决定）。\n');
  }

  // 2. identity
  let profile = '';
  try {
    profile = resolveProfile();
  } catch (e) {
    console.log(`❌ ${e.message}\n`);
    process.exit(1);
  }

  console.log(`lark-cli 身份（--profile ${profile}）：`);

  // One auth status call answers both "who am I" and "what scopes do I have".
  const granted = grantedScopes();
  if (granted.ok && granted.identity) {
    // Print only name + open_id. The rest of the auth payload carries token
    // state and must never reach the terminal or a log.
    console.log(`  ✅ ${granted.identity.name || '(名字未返回)'}  ${granted.identity.openId}`);
    console.log(`     已授权 scope ${granted.scopes.size} 条`);
    const selfId = cfg.config?.self_open_id;
    if (selfId && selfId !== granted.identity.openId) {
      console.log(`  ⚠️  feishu.config.self_open_id (${selfId}) 和当前身份不一致`);
    } else if (!selfId) {
      console.log(`  ℹ️  要开日报推送，把上面的 open_id 填进 feishu.config.self_open_id`);
    }
  } else {
    console.log(`  ❌ ${granted.error ? granted.error.split('\n')[0] : '身份不可用'}`);
    console.log(`     排查：lark-cli auth status --profile ${profile} --json --verify`);
  }
  console.log('');

  // 3. per-capability: config switch × actual scopes
  //
  // These two fail independently and that distinction is the whole point of this
  // script: a capability can be switched on with no scope (writes blow up with
  // 91403 / missing_scope at the worst moment), or fully scoped but switched off
  // (every call silently skips and the user wonders why nothing happens).
  console.log('能力矩阵（开关 × scope）：');
  for (const cap of KNOWN_CAPABILITIES) {
    const on = report.capabilities[cap];
    const miss = granted.ok ? missingScopes(cap, granted.scopes) : CAPABILITY_SCOPES[cap] || [];
    const scopeOk = miss.length === 0;
    let verdict;
    if (on && scopeOk) verdict = '可用';
    else if (!on && scopeOk) verdict = 'scope 齐，开关没开 → 把 profile.yml 里改成 true 即可';
    else if (on && !scopeOk) verdict = `⚠️ 开关开了但缺 scope：${miss.join(', ')}`;
    else verdict = `未启用（也缺 scope：${miss.join(', ')}）`;
    console.log(`  ${tick(on)}开关 ${tick(scopeOk)}scope  ${cap.padEnd(10)} ${verdict}`);
  }
  console.log('');

  if (granted.ok && KNOWN_CAPABILITIES.some(c => missingScopes(c, granted.scopes).length)) {
    console.log('补 scope 的正确顺序（别直接 auth login 扫码）：');
    console.log('  1. lark-cli auth scopes --profile ' + profile + '   # app 侧开没开 —— 没开的话用户授权也拿不到');
    console.log('  2. lark-cli schema <service.resource.method>        # 查准确 scope 字符串，别凭记忆写');
    console.log('  3. lark-cli auth login --profile ' + profile + ' --scope "<具体 scope>" --no-wait --json');
    console.log('     → 把 verification_url 出成二维码给用户 → 等用户确认后再 --device-code');
    console.log('');
  }

  // 4. degraded ledger
  const reminders = join(CAREER_OPS, 'data', 'reminders.md');
  if (existsSync(reminders)) {
    const { readFileSync } = await import('fs');
    const rows = readFileSync(reminders, 'utf-8').split('\n').filter(l => /^\|\s*\d{4}-\d{2}-\d{2}/.test(l));
    if (rows.length) {
      console.log(`降级台账 data/reminders.md 有 ${rows.length} 条未进飞书的提醒。`);
      console.log('开启 calendar / task 后新提醒直接进飞书；这些历史条目要手动处理。\n');
    }
  }

  console.log('详细说明：modes/feishu.md');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
