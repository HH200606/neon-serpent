/* =============================================================================
   Neon Serpent · 霓虹贪吃蛇
   -----------------------------------------------------------------------------
   零依赖 / 纯 Canvas 2D / 可离线运行。

   结构：
     1. 配置与状态
     2. 画布自适应（DPR）
     3. 游戏逻辑（固定步长 + 渲染插值）
     4. 绘制层
     5. 音效（WebAudio 合成，无音频文件）
     6. 输入（键盘 / 滑动 / 方向键）
     7. 界面状态（开始 / 暂停 / 结束）
     8. 主循环
   ========================================================================== */

(() => {
  'use strict';

  /* ------------------------------ 1. 配置 ---------------------------------- */

  const CFG = {
    cols: 24,
    rows: 24,
    baseStep: 150,      // 初始每步毫秒数
    minStep: 76,        // 最快
    speedUp: 0.978,     // 每吃一个果实加速比例
    comboWindow: 2600,  // 连击有效窗口（毫秒）
    comboMax: 5,
    bonusEvery: 5,      // 每吃 N 个果实出现一次金色果实
    bonusLife: 9000,
  };

  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };

  const STORE = { best: 'neon-serpent:best', muted: 'neon-serpent:muted' };

  /* ------------------------------ 2. DOM ----------------------------------- */

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

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isDemo = new URLSearchParams(location.search).get('demo') === '1';

  /* ------------------------------ 3. 状态 ---------------------------------- */

  const game = {
    mode: 'ready',        // ready | playing | paused | dying | over
    snake: [],
    prevSnake: [],
    dir: DIRS.right,
    nextDir: DIRS.right,
    fruit: { x: 0, y: 0 },
    bonus: null,          // { x, y, bornAt, dieAt }
    score: 0,
    best: readNumber(STORE.best),
    combo: 1,
    comboTimer: 0,
    eaten: 0,
    stepTimer: CFG.baseStep,
    acc: 0,
    dieAt: 0,
    shake: 0,
    particles: [],
  };

  const view = { size: 0, cell: 0, dpr: 1 };

  const audio = { ctx: null, muted: readBool(STORE.muted) };

  /* ---------------------- 4. 画布自适应（含 DPR） --------------------------- */

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

  if ('ResizeObserver' in window) {
    new ResizeObserver(fitCanvas).observe(stage);
  } else {
    window.addEventListener('resize', fitCanvas);
  }

  /* --------------------------- 5. 游戏逻辑 --------------------------------- */

  function resetGame() {
    const cx = Math.floor(CFG.cols / 2);
    const cy = Math.floor(CFG.rows / 2);

    game.snake = [
      { x: cx, y: cy },
      { x: cx - 1, y: cy },
      { x: cx - 2, y: cy },
    ];
    game.prevSnake = game.snake.map((s) => ({ ...s }));
    game.dir = DIRS.right;
    game.nextDir = DIRS.right;
    game.score = 0;
    game.combo = 1;
    game.comboTimer = 0;
    game.eaten = 0;
    game.stepTimer = CFG.baseStep;
    game.acc = 0;
    game.bonus = null;
    game.particles.length = 0;
    game.shake = 0;
    game.fruit = randomEmptyCell();
    syncHud();
  }

  function occupied(x, y) {
    if (game.fruit.x === x && game.fruit.y === y) return true;
    if (game.bonus && game.bonus.x === x && game.bonus.y === y) return true;
    return game.snake.some((s) => s.x === x && s.y === y);
  }

  function randomEmptyCell() {
    const free = [];
    for (let y = 0; y < CFG.rows; y++) {
      for (let x = 0; x < CFG.cols; x++) {
        if (!occupied(x, y)) free.push({ x, y });
      }
    }
    return free.length ? free[Math.floor(Math.random() * free.length)] : { x: 0, y: 0 };
  }

  function hitsBody(x, y, growing) {
    const limit = growing ? game.snake.length : game.snake.length - 1;
    for (let i = 0; i < limit; i++) {
      if (game.snake[i].x === x && game.snake[i].y === y) return true;
    }
    return false;
  }

  function step() {
    game.prevSnake = game.snake.map((s) => ({ ...s }));
    game.dir = game.nextDir;

    const head = game.snake[0];
    const nx = head.x + game.dir.x;
    const ny = head.y + game.dir.y;

    if (nx < 0 || ny < 0 || nx >= CFG.cols || ny >= CFG.rows) return die();

    const eatsFruit = game.fruit.x === nx && game.fruit.y === ny;
    const eatsBonus = !!game.bonus && game.bonus.x === nx && game.bonus.y === ny;
    const growing = eatsFruit || eatsBonus;

    if (hitsBody(nx, ny, growing)) return die();

    game.snake.unshift({ x: nx, y: ny });

    if (!growing) {
      game.snake.pop();
      return;
    }

    if (eatsBonus) {
      game.bonus = null;
      award(30, nx, ny, '#fbbf24', 18);
      playBonus();
    } else {
      award(10, nx, ny, '#f472b6', 12);
      playEat();
      game.eaten += 1;
      game.stepTimer = Math.max(CFG.minStep, CFG.baseStep * Math.pow(CFG.speedUp, game.eaten));
      game.fruit = randomEmptyCell();

      if (game.eaten % CFG.bonusEvery === 0 && !game.bonus) {
        const cell = randomEmptyCell();
        game.bonus = { x: cell.x, y: cell.y, bornAt: performance.now(), dieAt: performance.now() + CFG.bonusLife };
      }
    }
  }

  function award(base, x, y, color, count) {
    game.combo = game.comboTimer > 0 ? Math.min(CFG.comboMax, game.combo + 1) : 1;
    game.comboTimer = CFG.comboWindow;

    game.score += base * game.combo;
    if (game.score > game.best) {
      game.best = game.score;
      writeNumber(STORE.best, game.best);
    }

    burst(x, y, color, reduceMotion ? Math.ceil(count / 3) : count);
    game.shake = Math.max(game.shake, reduceMotion ? 0 : 3.2);
    syncHud();
  }

  function die() {
    if (game.mode !== 'playing') return;
    game.mode = 'dying';
    game.dieAt = performance.now() + (reduceMotion ? 220 : 620);
    game.shake = reduceMotion ? 0 : 12;
    playDie();

    const head = game.snake[0];
    burst(head.x, head.y, '#f472b6', reduceMotion ? 8 : 26);
    if (!reduceMotion) {
      game.snake.forEach((s, i) => {
        if (i % 2 === 0) burst(s.x, s.y, '#6366f1', 2);
      });
    }
  }

  function gameOver() {
    game.mode = 'over';
    if (game.score > game.best) {
      game.best = game.score;
      writeNumber(STORE.best, game.best);
    }
    syncHud();
    syncPauseButton();
    showOverlay({
      title: '游戏结束',
      html: `本局得分 <b>${game.score}</b> · 最高 <b>${game.best}</b><br>再来一局，把连击续上。`,
      button: '再来一局',
    });
  }

  function startGame() {
    resetGame();
    game.mode = 'playing';
    hideOverlay();
    syncPauseButton();
    ensureAudio();
    playStart();
  }

  function togglePause() {
    if (game.mode === 'playing') {
      game.mode = 'paused';
      showOverlay({ title: '已暂停', html: '喝口水，回来继续。', button: '继续游戏' });
    } else if (game.mode === 'paused') {
      game.mode = 'playing';
      hideOverlay();
    }
    syncPauseButton();
  }

  function syncPauseButton() {
    pauseBtn.textContent = game.mode === 'paused' ? '▶' : '⏸';
    pauseBtn.setAttribute('aria-label', game.mode === 'paused' ? '继续游戏' : '暂停');
  }

  /* ----------------------------- 6. 粒子 ----------------------------------- */

  function burst(cx, cy, color, count) {
    const cell = view.cell || 20;
    for (let i = 0; i < count; i++) {
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
    if (game.particles.length > 320) game.particles.splice(0, game.particles.length - 320);
  }

  function updateParticles(dt) {
    const s = dt / 1000;
    for (let i = game.particles.length - 1; i >= 0; i--) {
      const p = game.particles[i];
      p.x += p.vx * 60 * s;
      p.y += p.vy * 60 * s;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.life -= p.decay * s;
      if (p.life <= 0) game.particles.splice(i, 1);
    }
  }

  /* ----------------------------- 7. 绘制 ----------------------------------- */

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
    for (let i = 1; i < CFG.cols; i++) {
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
    for (let i = 0; i < 5; i++) {
      const a = (i * Math.PI * 2) / 5 - Math.PI / 2;
      const a2 = a + Math.PI / 5;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(Math.cos(a2) * r * 0.46, Math.sin(a2) * r * 0.46);
    }
    ctx.closePath();
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.restore();

    // 剩余时间环
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

    // 先铺一层柔和光晕，避免逐段 shadowBlur 的开销
    for (let i = len - 1; i >= 0; i--) {
      const seg = game.snake[i];
      const t = len === 1 ? 0 : i / (len - 1);
      ctx.fillStyle = `hsla(${188 + t * 62} 92% 62% / 0.16)`;
      roundRect(seg.x * cell - inset * 0.6, seg.y * cell - inset * 0.6,
        cell - inset * 0.8, cell - inset * 0.8, radius);
      ctx.fill();
    }

    for (let i = len - 1; i >= 0; i--) {
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

    // 头部高光与眼睛
    const head = game.snake[0];
    const hx = ((game.prevSnake[0] && progress > 0) ? head.x : head.x) * cell;
    const hy = head.y * cell;

    let hpx = hx + cell / 2;
    let hpy = hy + cell / 2;
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
    const progress = game.mode === 'playing'
      ? Math.min(1, Math.max(0, game.acc / game.stepTimer))
      : game.mode === 'dying' ? 1 : Math.min(1, game.acc / game.stepTimer);

    ctx.save();
    if (game.shake > 0.1) {
      const s = game.shake;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    drawBackground();
    drawFruit(now);
    drawBonus(now);
    drawSnake(game.mode === 'paused' ? 0 : progress);
    drawParticles();

    ctx.restore();
  }

  /* ----------------------------- 8. 音效 ----------------------------------- */

  function ensureAudio() {
    if (!audio.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audio.ctx = new AC();
    }
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
  }

  function blip({ freq = 440, to = 0, dur = 0.12, type = 'sine', gain = 0.05 }) {
    if (audio.muted) return;
    ensureAudio();
    const ac = audio.ctx;
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

  const playStart = () => { blip({ freq: 380, to: 620, dur: 0.16, type: 'triangle', gain: 0.045 }); };
  const playEat = () => { blip({ freq: 520, to: 760, dur: 0.10, type: 'square', gain: 0.035 }); };
  const playBonus = () => {
    blip({ freq: 660, dur: 0.09, type: 'triangle', gain: 0.045 });
    setTimeout(() => blip({ freq: 880, dur: 0.09, type: 'triangle', gain: 0.045 }), 80);
    setTimeout(() => blip({ freq: 1180, dur: 0.12, type: 'triangle', gain: 0.045 }), 160);
  };
  const playDie = () => { blip({ freq: 240, to: 55, dur: 0.42, type: 'sawtooth', gain: 0.05 }); };

  function toggleSound() {
    audio.muted = !audio.muted;
    writeBool(STORE.muted, audio.muted);
    syncSoundButton();
    if (!audio.muted) { ensureAudio(); playEat(); }
  }

  function syncSoundButton() {
    soundBtn.textContent = audio.muted ? '🔇' : '🔊';
    soundBtn.setAttribute('aria-pressed', String(!audio.muted));
  }

  /* ----------------------------- 9. 输入 ----------------------------------- */

  function setDirection(name) {
    if (game.mode === 'ready') { startGame(); }
    if (game.mode !== 'playing') return;

    const d = DIRS[name];
    if (!d) return;
    const cur = game.dir;
    if (d.x === -cur.x && d.y === -cur.y) return; // 禁止 180° 掉头
    if (d.x === cur.x && d.y === cur.y) return;
    game.nextDir = d;
  }

  const KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right',
  };

  window.addEventListener('keydown', (e) => {
    if (e.key in KEYMAP) {
      e.preventDefault();
      setDirection(KEYMAP[e.key]);
      return;
    }
    if (e.code === 'Space' || e.key === 'Enter') {
      e.preventDefault();
      if (game.mode === 'ready' || game.mode === 'over') startGame();
      else togglePause();
      return;
    }
    if (e.key === 'm' || e.key === 'M') toggleSound();
    if (e.key === 'r' || e.key === 'R') startGame();
  }, { passive: false });

  // 滑动
  let swipeStart = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    swipeStart = { x: e.clientX, y: e.clientY };
  });
  stage.addEventListener('pointerup', (e) => {
    if (!swipeStart) return;
    const dx = e.clientX - swipeStart.x;
    const dy = e.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
    setDirection(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  });
  stage.addEventListener('pointercancel', () => { swipeStart = null; });

  // 手机方向键
  dpad.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-dir]');
    if (!btn) return;
    e.preventDefault();
    setDirection(btn.dataset.dir);
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

  /* --------------------------- 10. 界面状态 -------------------------------- */

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
    bestEl.textContent = String(game.best);
    comboEl.textContent = `×${game.combo}`;
    comboWrap.hidden = game.combo <= 1;
  }

  /* ---------------------------- 11. 存档 ----------------------------------- */

  function readNumber(key) {
    try {
      const v = Number(localStorage.getItem(key));
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch { return 0; }
  }
  function writeNumber(key, value) {
    try { localStorage.setItem(key, String(value)); } catch { /* 隐私模式下忽略 */ }
  }
  function readBool(key) {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  }
  function writeBool(key, value) {
    try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* 忽略 */ }
  }

  /* ----------------------------- 12. 演示 ---------------------------------- */

  // 演示模式（?demo=1）：给截图 / 录屏用的自动寻路，不参与真实计分展示
  function botDirection() {
    const head = game.snake[0];
    const target = game.fruit;
    const options = Object.entries(DIRS).filter(([, d]) => !(d.x === -game.dir.x && d.y === -game.dir.y));

    const safe = options.filter(([, d]) => {
      const nx = head.x + d.x;
      const ny = head.y + d.y;
      if (nx < 0 || ny < 0 || nx >= CFG.cols || ny >= CFG.rows) return false;
      return !hitsBody(nx, ny, false);
    });
    if (!safe.length) return;

    safe.sort((a, b) => {
      const da = Math.abs(head.x + a[1].x - target.x) + Math.abs(head.y + a[1].y - target.y);
      const db = Math.abs(head.x + b[1].x - target.x) + Math.abs(head.y + b[1].y - target.y);
      return da - db;
    });
    game.nextDir = safe[0][1];
  }

  /* ----------------------------- 13. 主循环 -------------------------------- */

  let lastTime = performance.now();

  function update(dt, now) {
    if (game.mode === 'playing') {
      game.acc += dt;
      let guard = 0;
      while (game.acc >= game.stepTimer && game.mode === 'playing' && guard < 4) {
        game.acc -= game.stepTimer;
        if (isDemo) botDirection();
        step();
        guard += 1;
      }
    } else if (game.mode === 'ready' || game.mode === 'over') {
      game.acc = 0;
    }

    if (game.comboTimer > 0) {
      game.comboTimer -= dt;
      if (game.comboTimer <= 0) {
        game.comboTimer = 0;
        game.combo = 1;
        syncHud();
      }
    }

    if (game.bonus && now > game.bonus.dieAt) game.bonus = null;

    if (game.mode === 'dying' && now >= game.dieAt) gameOver();

    if (game.shake > 0.05) game.shake *= Math.pow(0.9, dt / 16);
    else game.shake = 0;

    updateParticles(dt);
  }

  function loop(now) {
    const dt = Math.min(now - lastTime, 120);
    lastTime = now;
    update(dt, now);
    render(now);
    requestAnimationFrame(loop);
  }

  /* ------------------------------ 14. 启动 --------------------------------- */

  fitCanvas();
  resetGame();
  syncSoundButton();
  syncPauseButton();

  if (isDemo) startGame();

  requestAnimationFrame((t) => {
    lastTime = t;
    loop(t);
  });
})();
