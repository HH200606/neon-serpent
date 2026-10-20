/* =============================================================================
   Neon Serpent · 规则层（FR-0.1）
   -----------------------------------------------------------------------------
   纯逻辑：不引用 window / document / ctx / AudioContext，可在 Node 下直接加载。
   时间由调用方注入（tick 的 now），随机数由调用方注入（rng），因此可测试。

   浏览器：<script src="js/rules.js"> → window.NeonRules
   Node：  const rules = require('./js/rules.js')
   ========================================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NeonRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------ 配置 ------------------------------------ */

  const CONFIG = Object.freeze({
    cols: 24,
    rows: 24,
    baseStep: 150,      // 初始步长（ms）
    minStep: 76,        // 最快步长
    speedUp: 0.978,     // 每吃一个普通果实乘一次
    comboWindow: 2600,  // 连击窗口（ms）
    comboMax: 5,
    fruitScore: 10,
    bonusScore: 30,
    bonusEvery: 5,      // 每 N 个普通果实出现金果实
    bonusLife: 9000,
    swipeThreshold: 24, // 滑动阈值（px），供 UI 层用
    particleCap: 320,
  });

  const DIRS = Object.freeze({
    up: Object.freeze({ x: 0, y: -1 }),
    down: Object.freeze({ x: 0, y: 1 }),
    left: Object.freeze({ x: -1, y: 0 }),
    right: Object.freeze({ x: 1, y: 0 }),
  });

  /* ------------------------------ 工具 ------------------------------------ */

  function snapshot(cells) {
    return cells.map((c) => ({ x: c.x, y: c.y }));
  }

  /** 步长：max(minStep, round(baseStep × speedUp^n))，n 为已吃普通果实数。 */
  function stepMsFor(eaten) {
    const n = Math.max(0, Math.floor(eaten) || 0);
    return Math.max(CONFIG.minStep, Math.round(CONFIG.baseStep * Math.pow(CONFIG.speedUp, n)));
  }

  function clampProgress(acc, stepMs) {
    if (!(stepMs > 0)) return 1;
    const p = acc / stepMs;
    if (!Number.isFinite(p)) return 0;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  function pick(list, rng) {
    const i = Math.min(list.length - 1, Math.max(0, Math.floor(rng() * list.length)));
    return list[i];
  }

  /* ------------------------------ 状态 ------------------------------------ */

  function createState(options) {
    const opts = options || {};
    const cols = opts.cols || CONFIG.cols;
    const rows = opts.rows || CONFIG.rows;
    const rng = opts.rng || Math.random;

    const cx = Math.floor(cols / 2);
    const cy = Math.floor(rows / 2);

    const state = {
      cols,
      rows,
      snake: [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }],
      prevSnake: [],
      dir: DIRS.right,
      nextDir: DIRS.right,
      pendingTurn: false,
      fruit: null,
      bonus: null,
      score: 0,
      combo: 1,
      eaten: 0,
      stepMs: CONFIG.baseStep,
      lastEatAt: null,
      status: 'playing',   // playing | dead
      deathCause: null,    // null | 'wall' | 'self'
    };

    state.prevSnake = snapshot(state.snake);
    placeFruit(state, rng);
    return state;
  }

  function occupied(state, x, y) {
    if (state.fruit && state.fruit.x === x && state.fruit.y === y) return true;
    if (state.bonus && state.bonus.x === x && state.bonus.y === y) return true;
    return state.snake.some((c) => c.x === x && c.y === y);
  }

  function key(state, x, y) {
    return y * state.cols + x;
  }

  /** 空格子（默认把现有果实与金果实都视为占用）。 */
  function freeCells(state, options) {
    const opts = options || {};
    const blocked = new Set();
    for (const c of state.snake) blocked.add(key(state, c.x, c.y));
    if (state.bonus) blocked.add(key(state, state.bonus.x, state.bonus.y));
    if (!opts.includeFruit && state.fruit) blocked.add(key(state, state.fruit.x, state.fruit.y));

    const cells = [];
    for (let y = 0; y < state.rows; y += 1) {
      for (let x = 0; x < state.cols; x += 1) {
        if (!blocked.has(key(state, x, y))) cells.push({ x, y });
      }
    }
    return cells;
  }

  /** 生成普通果实；棋盘已满时返回 null（不崩溃，FR-1.4）。 */
  function placeFruit(state, rng) {
    const cells = freeCells(state);
    if (!cells.length) {
      state.fruit = null;
      return null;
    }
    const cell = pick(cells, rng || Math.random);
    state.fruit = { x: cell.x, y: cell.y };
    return state.fruit;
  }

  /** 生成金果实；棋盘已满时返回 null。 */
  function placeBonus(state, now, rng) {
    const cells = freeCells(state);
    if (!cells.length) {
      state.bonus = null;
      return null;
    }
    const cell = pick(cells, rng || Math.random);
    state.bonus = { x: cell.x, y: cell.y, bornAt: now, dieAt: now + CONFIG.bonusLife };
    return state.bonus;
  }

  /* ------------------------------ 输入 ------------------------------------ */

  /**
   * 排队一个转向。返回是否被接受：
   * - 非 playing 状态一律拒绝
   * - 180° 反向、与当前方向相同 → 拒绝
   * - 本逻辑步已经有排队转向 → 只保留第一个（边界表：连续快速按两个方向只接受首个）
   */
  function queueDirection(state, name) {
    if (state.status !== 'playing') return false;
    const d = DIRS[name];
    if (!d) return false;

    const cur = state.dir;
    if (d.x === -cur.x && d.y === -cur.y) return false;
    if (d.x === cur.x && d.y === cur.y) return false;
    if (state.pendingTurn) return false;

    state.nextDir = d;
    state.pendingTurn = true;
    return true;
  }

  /* ------------------------------ 推进 ------------------------------------ */

  function hitsBody(state, x, y, growing) {
    const limit = growing ? state.snake.length : state.snake.length - 1;
    for (let i = 0; i < limit; i += 1) {
      if (state.snake[i].x === x && state.snake[i].y === y) return true;
    }
    return false;
  }

  function markDead(state, cause) {
    state.status = 'dead';
    state.deathCause = cause;
  }

  function applyEat(state, kind, now, rng) {
    const withinWindow = state.lastEatAt !== null && now - state.lastEatAt <= CONFIG.comboWindow;
    state.combo = withinWindow ? Math.min(CONFIG.comboMax, state.combo + 1) : 1;
    state.lastEatAt = now;
    state.score += (kind === 'bonus' ? CONFIG.bonusScore : CONFIG.fruitScore) * state.combo;

    if (kind === 'fruit') {
      state.eaten += 1;
      state.stepMs = stepMsFor(state.eaten);
      state.fruit = null;
      placeFruit(state, rng);
      if (state.eaten % CONFIG.bonusEvery === 0 && !state.bonus) placeBonus(state, now, rng);
    } else {
      state.bonus = null;
    }
  }

  /**
   * 推进一个逻辑步。返回本步的可见结果（不返回内部对象）。
   * @param {object} state
   * @param {{now?: number, rng?: () => number}} options
   */
  function tick(state, options) {
    const opts = options || {};
    const now = typeof opts.now === 'number' ? opts.now : 0;
    const rng = opts.rng || Math.random;
    const result = {
      ate: null,
      died: null,
      score: state.score,
      combo: state.combo,
      stepMs: state.stepMs,
    };

    if (state.status !== 'playing') return result;

    state.prevSnake = snapshot(state.snake);
    state.dir = state.nextDir;
    state.pendingTurn = false;

    const head = state.snake[0];
    const nx = head.x + state.dir.x;
    const ny = head.y + state.dir.y;

    if (nx < 0 || ny < 0 || nx >= state.cols || ny >= state.rows) {
      markDead(state, 'wall');
      result.died = 'wall';
      return result;
    }

    const eatsFruit = !!state.fruit && state.fruit.x === nx && state.fruit.y === ny;
    const eatsBonus = !!state.bonus && state.bonus.x === nx && state.bonus.y === ny && now <= state.bonus.dieAt;
    const growing = eatsFruit || eatsBonus;

    if (hitsBody(state, nx, ny, growing)) {
      markDead(state, 'self');
      result.died = 'self';
      return result;
    }

    state.snake.unshift({ x: nx, y: ny });
    if (!growing) state.snake.pop();

    if (eatsFruit) {
      applyEat(state, 'fruit', now, rng);
      result.ate = 'fruit';
    }
    if (eatsBonus) {
      applyEat(state, 'bonus', now, rng);
      result.ate = 'bonus';
    }

    result.score = state.score;
    result.combo = state.combo;
    result.stepMs = state.stepMs;
    return result;
  }

  /** 金果实超时消失；返回是否发生。 */
  function expireBonus(state, now) {
    if (state.bonus && now > state.bonus.dieAt) {
      state.bonus = null;
      return true;
    }
    return false;
  }

  /** 暂停恢复后把依赖绝对时间的计时器整体后移，避免暂停吃掉连击窗口 / 金果实寿命。 */
  function shiftTimers(state, delta) {
    if (!(delta > 0)) return false;
    if (state.lastEatAt !== null) state.lastEatAt += delta;
    if (state.bonus) {
      state.bonus.bornAt += delta;
      state.bonus.dieAt += delta;
    }
    return true;
  }

  /** 连击窗口过期把倍率复位；返回是否发生（供 HUD 同步用）。 */
  function refreshCombo(state, now) {
    if (state.lastEatAt === null) return false;
    if (now - state.lastEatAt <= CONFIG.comboWindow) return false;
    if (state.combo === 1) return false;
    state.combo = 1;
    return true;
  }

  return {
    CONFIG,
    DIRS,
    createState,
    occupied,
    freeCells,
    placeFruit,
    placeBonus,
    queueDirection,
    stepMsFor,
    tick,
    expireBonus,
    shiftTimers,
    refreshCombo,
    progress: clampProgress,
  };
});
