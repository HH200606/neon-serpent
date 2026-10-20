/* =============================================================================
   Neon Serpent · 存档层（FR-7）
   -----------------------------------------------------------------------------
   把 localStorage 的读写与“这次会话是不是 demo”的判定收在一处，
   这样 FR-7.4（demo 不得污染最高分）只有一个执行点，也好测。
   storage 由调用方注入，任何读写异常都降级为默认值，不影响对局。
   ========================================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NeonStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PREFIX = 'neon-serpent';
  const KEY = {
    best: PREFIX + ':best',
    muted: PREFIX + ':muted',
  };

  function readNumber(storage, key) {
    try {
      const raw = storage ? storage.getItem(key) : null;
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  function readBool(storage, key) {
    try {
      return storage ? storage.getItem(key) === '1' : false;
    } catch {
      return false;
    }
  }

  function write(storage, key, value) {
    if (!storage) return false;
    try {
      storage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {{getItem: Function, setItem: Function}|undefined|null} storage
   * @param {{demo?: boolean}} [options]
   */
  function createStore(storage, options) {
    const demo = !!(options && options.demo);

    return {
      readBest() {
        return readNumber(storage, KEY.best);
      },

      /** demo 会话一律不落盘（FR-7.4）；返回是否真的写入。 */
      writeBest(value) {
        if (demo) return false;
        if (!Number.isFinite(value) || value <= 0) return false;
        return write(storage, KEY.best, String(Math.floor(value)));
      },

      readMuted() {
        return readBool(storage, KEY.muted);
      },

      writeMuted(muted) {
        return write(storage, KEY.muted, muted ? '1' : '0');
      },
    };
  }

  return { KEY, createStore };
});
