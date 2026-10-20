/* =============================================================================
   埋点层单测 · 第 11 节 / FR-8.2
   ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';
import analytics from '../js/analytics.js';

const KEY = 'neon-serpent:events';

function fakeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

test('记录合法事件：带 ts、demo 与白名单字段', () => {
  const a = analytics.createAnalytics({ storage: fakeStorage(), demo: false, clock: () => 1000 });

  assert.equal(a.track('fruit_eaten', { type: 'normal', combo: 2, score: 30, stepMs: 143 }), true);

  const [event] = a.readAll();
  assert.deepEqual(event, {
    e: 'fruit_eaten',
    ts: 1000,
    demo: false,
    type: 'normal',
    combo: 2,
    score: 30,
    stepMs: 143,
  });
});

test('未知事件名被丢弃', () => {
  const a = analytics.createAnalytics({ storage: fakeStorage(), clock: () => 0 });

  assert.equal(a.track('nope', { score: 1 }), false);
  assert.equal(a.readAll().length, 0);
});

test('非白名单字段被丢弃', () => {
  const a = analytics.createAnalytics({ storage: fakeStorage(), clock: () => 0 });

  a.track('swipe', { ignored: false, dist: 30, secret: 'x', combo: 3 });

  assert.deepEqual(a.readAll()[0], { e: 'swipe', ts: 0, demo: false, ignored: false, dist: 30 });
});

test('FR-8.2 demo 事件带 demo=true，分析时可整体过滤', () => {
  const storage = fakeStorage();
  const demoLog = analytics.createAnalytics({ storage, demo: true, clock: () => 1 });
  demoLog.track('page_view', { ref: '', demo: true });
  demoLog.track('run_start', { source: 'direct', demo: true });

  const realLog = analytics.createAnalytics({ storage, demo: false, clock: () => 2 });
  realLog.track('run_start', { source: 'direct' });

  assert.equal(realLog.readAll({ includeDemo: true }).length, 3);
  const realOnly = realLog.readAll();
  assert.equal(realOnly.length, 1, '默认不返回 demo 事件');
  assert.equal(realOnly[0].demo, false);

  assert.equal(JSON.parse(realLog.exportJson()).length, 1, '导出默认也过滤 demo');
  assert.equal(JSON.parse(realLog.exportJson({ includeDemo: true })).length, 3);
});

test('超过上限时丢最旧的事件', () => {
  const a = analytics.createAnalytics({ storage: fakeStorage(), clock: () => 0, maxEvents: 3 });

  a.track('mute_toggle', { muted: true });
  a.track('mute_toggle', { muted: false });
  a.track('mute_toggle', { muted: true });
  a.track('mute_toggle', { muted: false });

  const events = a.readAll();
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.muted), [false, true, false]);
});

test('storage 抛异常时退化为内存记录，exportJson 仍可用', () => {
  const broken = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
  };
  const a = analytics.createAnalytics({ storage: broken, clock: () => 5 });

  assert.equal(a.track('death', { cause: 'wall', score: 0, durationSec: 3, comboMax: 1 }), true);
  assert.equal(a.readAll().length, 1);
  assert.deepEqual(JSON.parse(a.exportJson()), a.readAll());
});

test('storage 里是坏 JSON 时读作空列表', () => {
  const a = analytics.createAnalytics({ storage: fakeStorage({ [KEY]: '{oops' }), clock: () => 0 });

  assert.deepEqual(a.readAll(), []);
  assert.equal(a.track('run_end', { score: 10, best: 10, isNewBest: true, durationSec: 9 }), true);
  assert.equal(a.readAll().length, 1);
});

test('clear 清空事件', () => {
  const storage = fakeStorage();
  const a = analytics.createAnalytics({ storage, clock: () => 0 });
  a.track('mute_toggle', { muted: true });
  a.clear();

  assert.equal(a.readAll().length, 0);
  assert.equal(JSON.parse(storage.getItem(KEY) || '[]').length, 0);
  assert.deepEqual(JSON.parse(a.exportJson()), []);
});
