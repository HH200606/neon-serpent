/* =============================================================================
   存档层单测 · T-7 / FR-7.1 ~ FR-7.5
   ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';
import store from '../js/store.js';

const KEY = { best: 'neon-serpent:best', muted: 'neon-serpent:muted' };

function fakeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

const brokenStorage = () => ({
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
});

/* -------------------------------- T-7 ------------------------------------ */

test('T-7 demo 会话不写最高分：存储值不变，返回值 false', () => {
  const storage = fakeStorage({ [KEY.best]: '120' });
  const s = store.createStore(storage, { demo: true });

  assert.equal(s.readBest(), 120, '仍然读得到真实最高分');
  assert.equal(s.writeBest(900), false);
  assert.equal(storage.getItem(KEY.best), '120');
  assert.equal(s.readBest(), 120);
});

test('非 demo 会话正常写入最高分', () => {
  const storage = fakeStorage();
  const s = store.createStore(storage, { demo: false });

  assert.equal(s.writeBest(240), true);
  assert.equal(storage.getItem(KEY.best), '240');
  assert.equal(s.readBest(), 240);
});

test('静音状态读写往返并落在固定键上', () => {
  const storage = fakeStorage();
  const s = store.createStore(storage);

  assert.equal(s.readMuted(), false);
  assert.equal(s.writeMuted(true), true);
  assert.equal(storage.getItem(KEY.muted), '1');
  assert.equal(s.readMuted(), true);

  s.writeMuted(false);
  assert.equal(s.readMuted(), false);
  assert.equal(storage.getItem(KEY.muted), '0');
});

test('存储读写抛异常时降级：不崩溃，读到默认值', () => {
  const s = store.createStore(brokenStorage(), { demo: false });

  assert.equal(s.readBest(), 0);
  assert.equal(s.readMuted(), false);
  assert.equal(s.writeBest(100), false);
  assert.equal(s.writeMuted(true), false);
});

test('存储里是垃圾值时按默认值处理', () => {
  const storage = fakeStorage({ [KEY.best]: 'abc', [KEY.muted]: 'true' });
  const s = store.createStore(storage);

  assert.equal(s.readBest(), 0);
  assert.equal(s.readMuted(), false);
});

test('storage 缺失（隐私模式）时构造不崩溃', () => {
  const s = store.createStore(undefined);
  assert.equal(s.readBest(), 0);
  assert.equal(s.writeBest(10), false);
  assert.equal(s.readMuted(), false);
});

test('最高分只接受有限正数', () => {
  const storage = fakeStorage();
  const s = store.createStore(storage);

  assert.equal(s.writeBest(NaN), false);
  assert.equal(s.writeBest(-5), false);
  assert.equal(s.writeBest(Infinity), false);
  assert.equal(storage.getItem(KEY.best), null);
});
