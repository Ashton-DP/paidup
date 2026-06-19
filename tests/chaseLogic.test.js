const { test } = require('node:test');
const assert = require('node:assert');
const { nextChaseStage } = require('../src/ai');

const daysAgo     = n => new Date(Date.now() - n * 86400000).toISOString();
const daysFromNow = n => new Date(Date.now() + n * 86400000).toISOString();

// Base invoice helper
const inv = (over) => ({
  chase_stage: 0, days_overdue: 0, last_chased_at: null, snoozed_until: null, ...over,
});

test('fresh overdue invoice (stage 0, 1d) → stage 1', () => {
  assert.strictEqual(nextChaseStage(inv({ days_overdue: 1 })), 1);
});

test('stage 0 but not yet overdue (0d) → null', () => {
  assert.strictEqual(nextChaseStage(inv({ days_overdue: 0 })), null);
});

test('stage 1, 7d overdue, last chased 10d ago → stage 2', () => {
  assert.strictEqual(nextChaseStage(inv({ chase_stage: 1, days_overdue: 7, last_chased_at: daysAgo(10) })), 2);
});

test('stage 1, only 5d overdue → null (not due for stage 2 yet)', () => {
  assert.strictEqual(nextChaseStage(inv({ chase_stage: 1, days_overdue: 5, last_chased_at: daysAgo(10) })), null);
});

test('stage 2, 21d overdue, no prior chase timestamp → stage 3', () => {
  assert.strictEqual(nextChaseStage(inv({ chase_stage: 2, days_overdue: 21 })), 3);
});

test('stage 2, only 20d overdue → null (needs 21)', () => {
  assert.strictEqual(nextChaseStage(inv({ chase_stage: 2, days_overdue: 20, last_chased_at: daysAgo(10) })), null);
});

test('already at final stage (3) → null', () => {
  assert.strictEqual(nextChaseStage(inv({ chase_stage: 3, days_overdue: 60, last_chased_at: daysAgo(30) })), null);
});

test('6-day cooldown: chased 2 days ago → null even if otherwise due', () => {
  assert.strictEqual(nextChaseStage(inv({ chase_stage: 1, days_overdue: 30, last_chased_at: daysAgo(2) })), null);
});

test('6-day cooldown: chased exactly 6 days ago → proceeds', () => {
  assert.strictEqual(nextChaseStage(inv({ chase_stage: 1, days_overdue: 30, last_chased_at: daysAgo(6) })), 2);
});

test('snoozed into the future → null', () => {
  assert.strictEqual(nextChaseStage(inv({ days_overdue: 30, snoozed_until: daysFromNow(3) })), null);
});

test('snooze in the past no longer blocks → stage 1', () => {
  assert.strictEqual(nextChaseStage(inv({ days_overdue: 30, snoozed_until: daysAgo(1) })), 1);
});

// ── Configurable cadence ─────────────────────────────────────────────────────
const cad = { stage1: 3, stage2: 14, stage3: 30, cooldown: 10 };

test('custom cadence: stage 0 at 2d → null (needs 3)', () => {
  assert.strictEqual(nextChaseStage(inv({ days_overdue: 2 }), cad), null);
});
test('custom cadence: stage 0 at 3d → stage 1', () => {
  assert.strictEqual(nextChaseStage(inv({ days_overdue: 3 }), cad), 1);
});
test('custom cadence: stage 1 at 14d → stage 2', () => {
  assert.strictEqual(nextChaseStage(inv({ chase_stage: 1, days_overdue: 14, last_chased_at: daysAgo(12) }), cad), 2);
});
test('custom cadence: 10-day cooldown blocks a chase 8 days ago', () => {
  assert.strictEqual(nextChaseStage(inv({ chase_stage: 1, days_overdue: 30, last_chased_at: daysAgo(8) }), cad), null);
});
