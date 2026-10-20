/* =============================================================================
   Neon Serpent · 霓虹贪吃蛇
   -----------------------------------------------------------------------------
   零依赖 / 纯 Canvas 2D / 可离线运行。

   本文件只做「装配 + 表现」：
     - 规则：js/rules.js      （纯逻辑，Node 可测）
     - 存档：js/store.js      （demo 会话不写最高分）
     - 埋点：js/analytics.js  （本地聚合，demo 事件可过滤）
   渲染、音效、输入、界面状态留在这一层。

   结构：
      1. 依赖与配置
      2. DOM 与画布
      3. 运行状态
      4. 一局的生命周期（开始 / 暂停 / 死亡 / 结算）
      5. 音效（WebAudio 合成，无音频文件）
      6. 输入（键盘 / 滑动 / 方向键）
      7. 粒子与绘制
      8. HUD / 覆盖层 / 埋点出口
      9. 主循环
   ========================================================================== */

(() => {
  'use strict';

  /* --------------------------- 1. 依赖与配置 -------------------------------- */

  const R = window.NeonRules;
  const S = window.NeonStore;
  const A = window.NeonAnalytics;

  if (!R || !S || !A) {
    console.error('[neon-serpent] 规则 / 存档 / 埋点模块未加载，请检查 script 顺序。');
    return;
  }

  const CFG = R.CONFIG;
  const DIRS = R.DIRS;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const params = new URLSearchParams(location.search);
  const isDemo = params.get('demo') === '1';

  /* ----------------------------- 2. DOM 与画布 ------------------------------ */

  const $ = (id) => document.getElementById(id);
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const stage = $('stage');
  const overlay = $('overlay');
  const ovTitle = $('ovTitle');
  const ovText = $('ovText');
  const ovBtn = $('ovBtn');
  const scoreEl = $('score');
  const bestEl = $('best');
  const comboEl = $('combo');
  const comboWrap = $('comboWrap');
  const soundBtn = $('soundBtn');
  const pauseBtn = $('pauseBtn');
  const dpad = $('dpad');

  const view = { size: 0, cell: 0, dpr: 1 };

  function fitCanvas() {
    const rect = stage.getBoundingClientRect();
    const size = Math.max(120, Math.round(Math.min(rect.width, rect.height)));
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    view.size = size;
    view.cell = size / CFG.cols;
    view.dpr = dpr;
  }

  if ('ResizeObserver' in window) new ResizeObserver(fitCanvas).observe(stage);
  else window.addEventListener('resize', fitCanvas);

  /* ----------------------------- 3. 运行状态 -------------------------------- */

  function safeStorage() {
    try {
      const probe = '__neon__';
      window.localStorage.setItem(probe, probe);
      window.localStorage.removeItem(probe);
      return window.localStorage;
    } catch {
      return null;
    }
  }

  const storage = safeStorage();
  const store = S.createStore(storage, { demo: isDemo });
  const analytics = A.createAnalytics({ storage, demo: isDemo, clock: () => Date.now() });

  let best = store.readBest();

  let game = R.createState({ rng: Math.random });
  game.mode = 'ready';          // ready | playing | paused | dying | over
  game.acc = 0;                 // 步长累加器
  game.particles = [];
  game.shake = 0;
  game.dieAt = 0;

  const run = { startedAt: 0, activeMs: 0, comboMax: 1, overAt: 0 };

  const audio = { ctx: null, muted: store.readMuted(), unlocked: false };

  function durationSec() {
    return Math.round(run.activeMs / 100) / 10;
  }

  function referrerSource() {
    try {
      if (!document.referrer) return 'direct';
      return new URL(document.referrer).host === location.host ? 'direct' : 'share';
    } catch {
      return 'direct';
    }
  }

  /* --------------------------- 4. 一局的生命周期 ---------------------------- */

  function startGame() {
    if (game.mode === 'dying') return; // 死亡动画期间忽略重开（边界表）

    if (game.mode === 'over' && run.overAt) {
      analytics.track('retry', {
        previousScore: game.score,
        gapMs: Math.max(0, Math.round(performance.now() - run.overAt)),
      });
    }

    game = R.createState({ rng: Math.random });
    game.mode = 'playing';
    game.acc = 0;
    game.particles = [];
    game.shake = 0;
    game.dieAt = 0;

    run.activeMs = 0;
    run.startedAt = performance.now();
    run.comboMax = 1;
    run.overAt = 0;

    hideOverlay();
    syncHud();
    syncPauseButton();
    ensureAudio();
    playStart();

    analytics.track('run_start', { source: referrerSource(), demo: isDemo });
  }

  function togglePause() {
    if (game.mode === 'playing') {
      game.mode = 'paused';
      game.acc = 0;               // 恢复时不跳步（FR-6.1）
      suspendAudio();             // 暂停期间不留音效（FR-6.3）
      showOverlay({ title: '已暂停', html: '喝口水，回来继续。', button: '继续游戏' });
    } else if (game.mode === 'paused') {
      game.mode = 'playing';
      game.acc = 0;
      resumeAudio();
      hideOverlay();
    }
    syncPauseButton();
  }

  function onEat(result) {
    const head = game.snake[0];
    const gold = result.ate === 'bonus';

    burst(head.x, head.y, gold ? '#fbbf24' : '#f472b6', reduceMotion ? 6 : gold ? 18 : 12);
    game.shake = Math.max(game.shake, reduceMotion ? 0 : 3.2);
    if (gold) playBonus();
    else playEat();

    run.comboMax = Math.max(run.comboMax, game.combo);

    analytics.track('fruit_eaten', {
      type: gold ? 'gold' : 'normal',
      combo: game.combo,
      score: game.score,
      stepMs: game.stepMs,
    });

    // 最高分只在这里和结算时更新，且 demo 一律不落盘（FR-7.4）
    if (!isDemo && game.score > best) {
      best = game.score;
      store.writeBest(best);
    }

    syncHud();
  }

  function onDie(cause, now) {
    if (game.mode !== 'playing') return;

    game.mode = 'dying';
    game.dieAt = now + (reduceMotion ? 220 : 620);
    game.shake = reduceMotion ? 0 : 12;
    playDie();

    const head = game.snake[0];
    burst(head.x, head.y, '#f472b6', reduceMotion ? 8 : 26);
    if (!reduceMotion) {
      game.snake.forEach((cell, i) => {
        if (i % 2 === 0) burst(cell.x, cell.y, '#6366f1', 2);
      });
    }

    analytics.track('death', {
      cause,
      score: game.score,
      durationSec: durationSec(),
      comboMax: run.comboMax,
    });

    syncPauseButton();
  }

  function gameOver(now) {
    game.mode = 'over';
    run.overAt = now;

    const isNewBest = !isDemo && game.score > best && game.score > 0;
    if (isNewBest) {
      best = game.score;
      store.writeBest(best);
    }

    syncHud();
    syncPauseButton();

    analytics.track('run_end', {
      score: game.score,
      best,
      isNewBest,
      durationSec: durationSec(),
    });

    showOverlay({
      title: '游戏结束',
      html: `本局得分 <b>${game.score}</b> · 最高 <b>${best}</b><br>再来一局，把连击续上。`,
      button: '再来一局',
    });
  }

  function syncPauseButton() {
    const paused = game.mode === 'paused';
    pauseBtn.textContent = paused ? '▶' : '⏸';
    pauseBtn.setAttribute('aria-label', paused ? '继续游戏' : '暂停');
  }

  /* ------------------------------- 5. 音效 --------------------------------- */

  function ensureAudio() {
    if (!audio.unlocked) return null; // NFR-7：首次手势后才创建
    if (!audio.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        audio.ctx = new AC();
      } catch {
        return null;
      }
    }
    if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
    return audio.ctx;
  }

  function suspendAudio() {
    try {
      if (audio.ctx && audio.ctx.state === 'running') audio.ctx.suspend().catch(() => {});
    } catch { /* 忽略 */ }
  }

  function resumeAudio() {
    try {
      if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
    } catch { /* 忽略 */ }
  }

  function blip({ freq = 440, to = 0, dur = 0.12, type = 'sine', gain = 0.05 }) {
    if (audio.muted) return;
    const ac = ensureAudio();
    if (!ac) return;

    const osc = ac.createOscillator();
    const amp = ac.createGain();
    const t0 = ac.currentTime;

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(30, to), t0 + dur);

    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(amp).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function playStart() { blip({ freq: 380, to: 620, dur: 0.16, type: 'triangle', gain: 0.045 }); }
  function playEat() { blip({ freq: 520, to: 760, dur: 0.10, type: 'square', gain: 0.035 }); }
  function playBonus() {
    blip({ freq: 660, dur: 0.09, type: 'triangle', gain: 0.045 });
    setTimeout(() => blip({ freq: 880, dur: 0.09, type: 'triangle', gain: 0.045 }), 80);
    setTimeout(() => blip({ freq: 1180, dur: 0.12, type: 'triangle', gain: 0.045 }), 160);
  }
  function playDie() { blip({ freq: 240, to: 55, dur: 0.42, type: 'sawtooth', gain: 0.05 }); }

  function toggleSound() {
    audio.muted = !audio.muted;
    store.writeMuted(audio.muted);
    analytics.track('mute_toggle', { muted: audio.muted });
    syncSoundButton();
    if (!audio.muted) {
      ensureAudio();
      playEat();
    }
  }

  function syncSoundButton() {
    soundBtn.textContent = audio.muted ? '🔇' : '🔊';
    soundBtn.setAttribute('aria-pressed', String(!audio.muted));
  }

  /* ------------------------------- 6. 输入 --------------------------------- */

  function turn(name) {
    if (game.mode === 'ready' || game.mode === 'over') startGame();
    if (game.mode !== 'playing') return false;
    return R.queueDirection(game, name);
  }

  const KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right',
  };

  window.addEventListener('keydown', (e) => {
    audio.unlocked = true;

    if (e.key in KEYMAP) {
      e.preventDefault();
      turn(KEYMAP[e.key]);
      return;
    }
    if (e.code === 'Space' || e.key === 'Enter') {
      e.preventDefault();
      if (game.mode === 'ready' || game.mode === 'over') startGame();
      else if (game.mode === 'playing' || game.mode === 'paused') togglePause();
      return;
    }
    if (e.key === 'm' || e.key === 'M') toggleSound();
    if (e.key === 'r' || e.key === 'R') startGame();
  }, { passive: false });

  // 滑动（阈值 24px，FR-5.3）
  let swipeStart = null;

  stage.addEventListener('pointerdown', (e) => {
    audio.unlocked = true;
    if (e.target.closest('button')) return;
    swipeStart = { x: e.clientX, y: e.clientY };
  });

  stage.addEventListener('pointerup', (e) => {
    if (!swipeStart) return;
    const dx = e.clientX - swipeStart.x;
    const dy = e.clientY - swipeStart.y;
    swipeStart = null;

    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const dist = Math.max(absX, absY);
    if (dist < 8) return; // 抖动噪声，不计入误触统计

    const accepted = dist >= CFG.swipeThreshold
      && turn(absX > absY ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));

    analytics.track('swipe', { ignored: !accepted, dist: Math.round(dist) });
  });

  stage.addEventListener('pointercancel', () => { swipeStart = null; });

  dpad.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-dir]');
    if (!btn) return;
    audio.unlocked = true;
    e.preventDefault();
    turn(btn.dataset.dir);
  });

  ovBtn.addEventListener('click', () => {
    if (game.mode === 'paused') togglePause();
    else startGame();
  });

  pauseBtn.addEventListener('click', () => {
    if (game.mode === 'playing' || game.mode === 'paused') togglePause();
  });

  soundBtn.addEventListener('click', toggleSound);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.mode === 'playing') togglePause();
  });

  /* --------------------------- 7. 粒子与绘制 -------------------------------- */

  function burst(cx, cy, color, count) {
    const cell = view.cell || 20;
    const cap = CFG.particleCap || 320;

    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (0.6 + Math.random() * 2.4) * cell * 0.06;
      game.particles.push({
        x: (cx + 0.5) * cell,
        y: (cy + 0.5) * cell,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        decay: 0.9 + Math.random() * 1.6,
        size: cell * (0.10 + Math.random() * 0.16),
        color,
      });
    }
    if (game.particles.length > cap) game.particles.splice(0, game.particles.length - cap);
  }

  function updateParticles(dt) {
    const s = dt / 1000;
    for (let i = game.particles.length - 1; i >= 0; i -= 1) {
      const p = game.particles[i];
      p.x += p.vx * 60 * s;
      p.y += p.vy * 60 * s;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.life -= p.decay * s;
      if (p.life <= 0) game.particles.splice(i, 1);
    }
  }

  function drawBackground() {
    const { size } = view;
    ctx.clearRect(0, 0, size, size);

    const bg = ctx.createRadialGradient(size * 0.5, size * 0.42, size * 0.05, size * 0.5, size * 0.5, size * 0.8);
    bg.addColorStop(0, '#0d1728');
    bg.addColorStop(1, '#070a12');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

    const cell = view.cell;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.075)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < CFG.cols; i += 1) {
      const p = Math.round(i * cell) + 0.5;
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
    }
    ctx.stroke();

    const vig = ctx.createRadialGradient(size / 2, size / 2, size * 0.36, size / 2, size / 2, size * 0.74);
    vig.addColorStop(0, 'rgba(7, 10, 18, 0)');
    vig.addColorStop(1, 'rgba(7, 10, 18, 0.78)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, size, size);
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawFruit(now) {
    if (!game.fruit) return;

    const cell = view.cell;
    const cx = (game.fruit.x + 0.5) * cell;
    const cy = (game.fruit.y + 0.5) * cell;
    const t = reduceMotion ? 0 : Math.sin(now / 320) * 0.5 + 0.5;
    const r = cell * (0.26 + t * 0.05);

    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, cell * 0.95);
    glow.addColorStop(0, 'rgba(244, 114, 182, 0.55)');
    glow.addColorStop(1, 'rgba(244, 114, 182, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.95, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f472b6';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    ctx.arc(cx - r * 0.32, cy - r * 0.34, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBonus(now) {
    if (!game.bonus) return;

    const cell = view.cell;
    const cx = (game.bonus.x + 0.5) * cell;
    const cy = (game.bonus.y + 0.5) * cell;
    const left = Math.max(0, (game.bonus.dieAt - now) / CFG.bonusLife);
    const pulse = reduceMotion ? 0.5 : Math.sin(now / 180) * 0.5 + 0.5;
    const r = cell * (0.28 + pulse * 0.05);
    const spin = reduceMotion ? 0 : now / 900;

    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, cell);
    glow.addColorStop(0, 'rgba(251, 191, 36, 0.55)');
    glow.addColorStop(1, 'rgba(251, 191, 36, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, cell, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(spin);
    ctx.beginPath();
    for (let i = 0; i < 5; i += 1) {
      const a = (i * Math.PI * 2) / 5 - Math.PI / 2;
      const a2 = a + Math.PI / 5;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(Math.cos(a2) * r * 0.46, Math.sin(a2) * r * 0.46);
    }
    ctx.closePath();
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.restore();

    // 剩余时间环（FR-3.4）
    ctx.strokeStyle = `rgba(251, 191, 36, ${0.35 + left * 0.5})`;
    ctx.lineWidth = Math.max(1.5, cell * 0.07);
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.44, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
    ctx.stroke();
  }

  function drawSnake(progress) {
    const cell = view.cell;
    const len = game.snake.length;
    const inset = Math.max(1.2, cell * 0.075);
    const radius = Math.max(3, cell * 0.32);

    for (let i = len - 1; i >= 0; i -= 1) {
      const seg = game.snake[i];
      const t = len === 1 ? 0 : i / (len - 1);
      ctx.fillStyle = `hsla(${188 + t * 62} 92% 62% / 0.16)`;
      roundRect(seg.x * cell - inset * 0.6, seg.y * cell - inset * 0.6,
        cell - inset * 0.8, cell - inset * 0.8, radius);
      ctx.fill();
    }

    for (let i = len - 1; i >= 0; i -= 1) {
      const seg = game.snake[i];
      const t = len === 1 ? 0 : i / (len - 1);
      const hue = 188 + t * 62;
      let x = seg.x;
      let y = seg.y;

      if (i === 0 && game.prevSnake[0] && progress > 0 && progress <= 1) {
        const from = game.prevSnake[0];
        if (Math.abs(from.x - seg.x) + Math.abs(from.y - seg.y) === 1) {
          x = from.x + (seg.x - from.x) * progress;
          y = from.y + (seg.y - from.y) * progress;
        }
      }

      ctx.fillStyle = `hsl(${hue} 90% ${62 - t * 12}%)`;
      if (i === 0) {
        ctx.save();
        ctx.shadowColor = 'rgba(34, 211, 238, 0.85)';
        ctx.shadowBlur = cell * 0.75;
      }
      roundRect(x * cell + inset * 0.5, y * cell + inset * 0.5, cell - inset, cell - inset, radius);
      ctx.fill();
      if (i === 0) ctx.restore();
    }

    // 头部高光与眼睛（跟随插值位置）
    const head = game.snake[0];
    let hpx = (head.x + 0.5) * cell;
    let hpy = (head.y + 0.5) * cell;

    if (game.prevSnake[0] && progress > 0 && progress <= 1) {
      const from = game.prevSnake[0];
      if (Math.abs(from.x - head.x) + Math.abs(from.y - head.y) === 1) {
        hpx = (from.x + (head.x - from.x) * progress + 0.5) * cell;
        hpy = (from.y + (head.y - from.y) * progress + 0.5) * cell;
      }
    }

    ctx.fillStyle = '#e0fbff';
    const eye = cell * 0.10;
    const off = cell * 0.17;
    const dx = game.dir.x;
    const dy = game.dir.y;
    const px = dy !== 0 ? off : 0;
    const py = dx !== 0 ? off : 0;
    const fx = dx * off * 0.8;
    const fy = dy * off * 0.8;
    ctx.beginPath();
    ctx.arc(hpx + px + fx, hpy + py + fy, eye, 0, Math.PI * 2);
    ctx.arc(hpx - px + fx, hpy - py + fy, eye, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawParticles() {
    for (const p of game.particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  function render(now) {
    const progress = game.mode === 'paused'
      ? 0
      : R.progress(game.acc, game.stepMs);

    ctx.save();
    if (game.shake > 0.1) {
      const s = game.shake;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    drawBackground();
    drawFruit(now);
    drawBonus(now);
    drawSnake(progress);
    drawParticles();

    ctx.restore();
  }

  /* ------------------------- 8. HUD / 覆盖层 / 埋点 ------------------------- */

  function showOverlay({ title, html, button }) {
    ovTitle.textContent = title;
    ovText.innerHTML = html;
    ovBtn.textContent = button;
    overlay.classList.add('is-visible');
  }

  function hideOverlay() {
    overlay.classList.remove('is-visible');
  }

  function syncHud() {
    scoreEl.textContent = String(game.score);
    bestEl.textContent = String(best);
    comboEl.textContent = `×${game.combo}`;
    comboWrap.hidden = game.combo <= 1;
  }

  const frameLog = [];
  let frameSeq = 0;

  function trackFrame(dt) {
    frameSeq += 1;
    frameLog.push(dt);
    if (frameLog.length > 180) frameLog.shift();
    if (frameSeq % 60 !== 0 || frameLog.length < 30) return;

    const sorted = [...frameLog].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const dropped = frameLog.filter((d) => d > 16.7).length / frameLog.length;
    analytics.track('frame_stats', {
      p95FrameMs: Math.round(p95 * 10) / 10,
      droppedRatio: Math.round(dropped * 1000) / 1000,
    });
  }

  function downloadJson(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // 本地聚合 → 手动导出（PRD 11.2）；分析前默认过滤 demo 事件（FR-8.2）
  window.NeonStats = {
    events: (opts) => analytics.readAll(opts || { includeDemo: false }),
    export: (includeDemo = false) => {
      const data = analytics.readAll({ includeDemo });
      downloadJson(`neon-serpent-events-${Date.now()}.json`, JSON.stringify(data, null, 2));
      return data.length;
    },
    clear: () => analytics.clear(),
  };

  // 调试 / 端到端测试用的只读句柄
  window.NeonSerpent = {
    rules: R,
    state: () => game,
    best: () => best,
    mode: () => game.mode,
  };

  /* ---------------------------- 9. 演示模式 --------------------------------- */

  function botDirection() {
    const head = game.snake[0];
    const target = game.bonus || game.fruit;
    if (!target) return;

    const blocked = new Set();
    for (let i = 0; i < game.snake.length - 1; i += 1) {
      blocked.add(game.snake[i].y * game.cols + game.snake[i].x);
    }

    const options = Object.keys(DIRS)
      .map((name) => [name, DIRS[name]])
      .filter(([, d]) => {
        if (d.x === -game.dir.x && d.y === -game.dir.y) return false;
        const nx = head.x + d.x;
        const ny = head.y + d.y;
        if (nx < 0 || ny < 0 || nx >= game.cols || ny >= game.rows) return false;
        return !blocked.has(ny * game.cols + nx);
      });

    if (!options.length) return;

    const dist = (d) => Math.abs(head.x + d.x - target.x) + Math.abs(head.y + d.y - target.y);
    options.sort((a, b) => dist(a[1]) - dist(b[1]));
    R.queueDirection(game, options[0][0]);
  }

  /* ------------------------------ 10. 主循环 -------------------------------- */

  let lastTime = performance.now();

  function update(dt, now) {
    trackFrame(dt);

    if (game.mode === 'playing') {
      game.acc += dt;
      run.activeMs += dt;

      let guard = 0;
      while (game.acc >= game.stepMs && game.mode === 'playing' && guard < 4) {
        game.acc -= game.stepMs;
        if (isDemo) botDirection();

        const result = R.tick(game, { now, rng: Math.random });
        if (result.ate) onEat(result);
        if (result.died) onDie(result.died, now);
        guard += 1;
      }

      if (R.refreshCombo(game, now)) syncHud();
      R.expireBonus(game, now);
    } else if (game.mode === 'ready' || game.mode === 'over') {
      game.acc = 0;
    }

    if (game.mode === 'dying' && now >= game.dieAt) gameOver(now);

    if (game.shake > 0.05) game.shake *= Math.pow(0.9, dt / 16);
    else game.shake = 0;

    updateParticles(dt);
  }

  function loop(now) {
    const raw = now - lastTime;
    const dt = Math.min(raw, 120);
    lastTime = now;
    update(dt, now);
    render(now);
    requestAnimationFrame(loop);
  }

  /* ------------------------------- 11. 启动 -------------------------------- */

  fitCanvas();
  syncSoundButton();
  syncPauseButton();
  syncHud();

  analytics.track('page_view', { ref: document.referrer || '', demo: isDemo });

  if (isDemo) startGame();

  requestAnimationFrame((t) => {
    lastTime = t;
    loop(t);
  });
})();
