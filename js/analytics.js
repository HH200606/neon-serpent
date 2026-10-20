/* =============================================================================
   Neon Serpent · 埋点（第 11 节 / FR-8.2）
   -----------------------------------------------------------------------------
   只做本地聚合：事件写进 localStorage（环形上限），需要时导出 JSON 人工分析。
   不引第三方脚本、不发网络请求（NFR-9 / NFR-10）。
   demo 会话的事件带 demo=true，分析前可整体过滤（FR-8.2）。
   ========================================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NeonAnalytics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'neon-serpent:events';
  const MAX_EVENTS = 500;

  /** 事件 → 允许的字段（PRD 11.1）。 */
  const SCHEMA = Object.freeze({
    page_view: ['ref', 'demo'],
    run_start: ['source', 'demo'],
    fruit_eaten: ['type', 'combo', 'score', 'stepMs'],
    swipe: ['ignored', 'dist'],
    death: ['cause', 'score', 'durationSec', 'comboMax'],
    run_end: ['score', 'best', 'isNewBest', 'durationSec'],
    retry: ['previousScore', 'gapMs'],
    mute_toggle: ['muted'],
    frame_stats: ['p95FrameMs', 'droppedRatio'],
  });

  const EVENT_NAMES = Object.freeze(Object.keys(SCHEMA));

  function load(storage) {
    try {
      const raw = storage ? storage.getItem(STORAGE_KEY) : null;
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e === 'object') : [];
    } catch {
      return [];
    }
  }

  function save(storage, events) {
    if (!storage) return false;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(events));
      return true;
    } catch {
      return false;
    }
  }

  function pickFields(name, fields) {
    const out = {};
    if (!fields) return out;
    for (const key of SCHEMA[name]) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) out[key] = fields[key];
    }
    return out;
  }

  /**
   * @param {{storage?: Storage, demo?: boolean, clock?: () => number, maxEvents?: number}} [options]
   */
  function createAnalytics(options) {
    const opts = options || {};
    const storage = opts.storage;
    const demo = !!opts.demo;
    const clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
    const maxEvents = Number.isFinite(opts.maxEvents) && opts.maxEvents > 0
      ? Math.floor(opts.maxEvents)
      : MAX_EVENTS;

    let events = load(storage);

    function readAll(readOpts) {
      // 默认不返回 demo 事件（FR-8.2）：分析前先过滤，显式 includeDemo:true 才拿到全部
      const includeDemo = !!readOpts && readOpts.includeDemo === true;
      const list = includeDemo ? events : events.filter((e) => !e.demo);
      return list.map((e) => ({ ...e }));
    }

    return {
      /** 记录一条事件；未知事件名直接丢弃并返回 false。 */
      track(name, fields) {
        if (!Object.prototype.hasOwnProperty.call(SCHEMA, name)) return false;

        const record = { e: name, ts: clock(), demo };
        Object.assign(record, pickFields(name, fields));

        events.push(record);
        if (events.length > maxEvents) events = events.slice(events.length - maxEvents);

        save(storage, events);
        return true;
      },

      readAll,

      exportJson(readOpts) {
        return JSON.stringify(readAll(readOpts), null, 2);
      },

      clear() {
        events = [];
        save(storage, events);
      },
    };
  }

  return {
    STORAGE_KEY,
    SCHEMA,
    EVENT_NAMES,
    createAnalytics,
  };
});
