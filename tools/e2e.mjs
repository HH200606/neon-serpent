#!/usr/bin/env node
/* =============================================================================
   AC-3 / AC-5 / AC-6 / NFR-5 · 端到端验收
   -----------------------------------------------------------------------------
   零依赖：Node 内置 http + WebSocket 直连 Edge/Chrome 的 CDP，不装 puppeteer。
   每个场景用独立的 browser context（隔离 localStorage），跑完自动关浏览器。

   用法：
     node tools/e2e.mjs              # 全部场景
     node tools/e2e.mjs --capture    # 另外把 1200×630 截图写进 assets/og-cover.png
   ========================================================================== */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const CAPTURE = process.argv.includes('--capture');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 静态服务器 -------------------------------- */

function startServer() {
  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.statusCode = 400;
      res.end('bad request');
      return;
    }
    if (pathname === '/') pathname = '/index.html';

    const file = path.join(ROOT, pathname);
    if (!file.startsWith(ROOT) || !existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(file));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* ---------------------------------- CDP ---------------------------------- */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();

    ws.addEventListener('message', (event) => this.onMessage(JSON.parse(event.data)));
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`WebSocket 连接失败：${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    for (const listener of this.listeners.get(msg.method) || []) {
      listener(msg.params, msg.sessionId);
    }
  }

  send(method, params = {}, sessionId) {
    const id = (this.nextId += 1);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 15000).unref?.();
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  close() {
    try { this.ws.close(); } catch { /* 忽略 */ }
  }
}

/* -------------------------------- 浏览器 ---------------------------------- */

function edgeCandidates() {
  return [
    process.env.EDGE_PATH,
    process.env.CHROME_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
}

async function launchBrowser() {
  const exe = edgeCandidates().find((p) => existsSync(p));
  if (!exe) throw new Error('找不到 Edge / Chrome，可用 EDGE_PATH 环境变量指定');

  const userDir = mkdtempSync(path.join(tmpdir(), 'neon-e2e-'));
  const child = spawn(exe, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const portFile = path.join(userDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  while (!existsSync(portFile) && Date.now() < deadline) await sleep(100);
  if (!existsSync(portFile)) {
    child.kill();
    throw new Error('浏览器没有写出 DevToolsActivePort（启动失败）');
  }

  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);

  return { exe, child, userDir, port, cdp };
}

/* --------------------------------- 页面 ---------------------------------- */

async function openPage(browser, url, options = {}) {
  const { width = 1280, height = 800, deviceScaleFactor = 1, mobile = false, touch = false } = options;

  const { browserContextId } = await browser.cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await browser.cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const errors = [];
  const cdp = browser.cdp;

  const onMessage = (params, sid) => {
    if (sid !== sessionId) return;
    if (params.type === 'error') {
      errors.push(params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
  };
  const onException = (params, sid) => {
    if (sid !== sessionId) return;
    errors.push(params.exception?.description || params.exception?.value || 'uncaught exception');
  };

  cdp.on('Runtime.consoleAPICalled', onMessage);
  cdp.on('Runtime.exceptionThrown', onException);

  const send = (method, params) => cdp.send(method, params, sessionId);

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
  await send('Emulation.setTouchEmulationEnabled', touch
    ? { enabled: true, maxTouchPoints: 5 }
    : { enabled: false });

  const page = {
    errors,
    async goto(target) {
      await send('Page.navigate', { url: target });
      await page.waitFor('document.readyState === "complete"', 15000);
    },
    async waitFor(expression, timeout = 8000, interval = 100) {
      const deadline = Date.now() + timeout;
      let lastError;
      while (Date.now() < deadline) {
        try {
          if (await page.eval(expression)) return true;
        } catch (error) {
          lastError = error;
        }
        await sleep(interval);
      }
      throw new Error(`等待超时：${expression}${lastError ? `（最后一次错误：${lastError.message}）` : ''}`);
    },
    async eval(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || 'Runtime.evaluate 抛异常');
      }
      return result.result.value;
    },
    async key(key) {
      const code = key === ' ' ? 'Space' : key;
      await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true }))`);
    },
    async setMetrics(metrics) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, ...metrics,
      });
      await sleep(250);
    },
    async screenshot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    },
    async close() {
      await send('Target.closeTarget', { targetId }).catch(() => {});
      await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    },
  };

  await page.goto(url);
  return page;
}

/* --------------------------------- 断言 ---------------------------------- */

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  const mark = ok ? '✔' : '✖';
  console.log(`${mark} ${name}${ok || !detail ? '' : `\n    ↳ ${detail}`}`);
}

/* -------------------------------- 场景 ----------------------------------- */

async function scenarioLoad(browser, base) {
  console.log('\n[S1] 冷启动与首屏结构');
  const page = await openPage(browser, `${base}/index.html`);
  await page.waitFor('!!window.NeonSerpent');

  const info = await page.eval(`(() => ({
    mode: NeonSerpent.mode(),
    overlay: document.getElementById('overlay').classList.contains('is-visible'),
    title: document.title,
    canvas: document.getElementById('board').width,
    score: document.getElementById('score').textContent,
    best: document.getElementById('best').textContent,
  }))()`);

  check('S1.1 初始状态为 ready', info.mode === 'ready', `mode=${info.mode}`);
  check('S1.2 开始面板可见', info.overlay === true);
  check('S1.3 标题正确', info.title.includes('霓虹贪吃蛇'), info.title);
  check('S1.4 画布有后备分辨率', info.canvas > 0, `canvas.width=${info.canvas}`);
  check('S1.5 冷启动控制台零 error', page.errors.length === 0, page.errors.join(' | '));

  await page.close();
}

async function scenarioKeyboard(browser, base) {
  console.log('\n[S2] 纯键盘：开局、转向、吃果实、最高分落盘（AC-6）');
  const page = await openPage(browser, `${base}/index.html`);
  await page.waitFor('!!window.NeonSerpent');

  await page.key(' ');
  await page.waitFor(`NeonSerpent.mode() === 'playing'`);
  check('S2.1 空格开局', true);

  await page.key('ArrowUp');
  await sleep(400);
  const dir = await page.eval('NeonSerpent.state().dir');
  check('S2.2 方向键生效', dir.x === 0 && dir.y === -1, JSON.stringify(dir));

  await page.eval(`(() => {
    const s = NeonSerpent.state();
    const h = s.snake[0];
    s.fruit = { x: h.x + s.dir.x, y: h.y + s.dir.y };
  })()`);
  await page.waitFor('NeonSerpent.state().score > 0', 5000);

  const afterEat = await page.eval(`(() => ({
    score: NeonSerpent.state().score,
    hud: document.getElementById('score').textContent,
    stored: Number(localStorage.getItem('neon-serpent:best') || 0),
  }))()`);
  check('S2.3 吃到果实加分并同步 HUD', afterEat.score > 0 && afterEat.hud === String(afterEat.score), JSON.stringify(afterEat));
  check('S2.4 非 demo 会话把最高分写进 localStorage', afterEat.stored === afterEat.score, `stored=${afterEat.stored} score=${afterEat.score}`);

  await page.key(' ');
  await page.waitFor(`NeonSerpent.mode() === 'paused'`);
  const paused = await page.eval(`(() => ({
    title: document.getElementById('ovTitle').textContent,
    btn: document.getElementById('pauseBtn').textContent,
  }))()`);
  check('S2.5 空格暂停并同步按钮图标', paused.title === '已暂停' && paused.btn === '▶', JSON.stringify(paused));

  await page.key(' ');
  await page.waitFor(`NeonSerpent.mode() === 'playing'`);
  check('S2.6 再按空格恢复', true);
  check('S2.7 键盘流程控制台零 error', page.errors.length === 0, page.errors.join(' | '));

  await page.close();
}

async function scenarioMobile(browser, base) {
  console.log('\n[S3] 375px 视口：无横向滚动、方向键可点（AC-5）');
  const page = await openPage(browser, `${base}/index.html`, {
    width: 375, height: 667, deviceScaleFactor: 2, mobile: true, touch: true,
  });
  await page.waitFor('!!window.NeonSerpent');
  await sleep(400);

  const layout = await page.eval(`(() => {
    const dpad = document.getElementById('dpad');
    const buttons = [...document.querySelectorAll('button')];
    const tooSmall = buttons.filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width < 30 || r.height < 30;
    }).map((b) => b.id || b.dataset.dir || b.textContent.trim());
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      dpadDisplay: getComputedStyle(dpad).display,
      smallButtons: tooSmall,
      overlayVisible: document.getElementById('overlay').classList.contains('is-visible'),
    };
  })()`);

  check('S3.1 没有横向滚动', layout.scrollWidth <= layout.innerWidth + 1, `${layout.scrollWidth} > ${layout.innerWidth}`);
  check('S3.2 粗指针设备显示方向键', layout.dpadDisplay !== 'none', `display=${layout.dpadDisplay}`);
  check('S3.3 按钮都够大（≥30px）', layout.smallButtons.length === 0, layout.smallButtons.join(','));
  check('S3.4 开始面板在小屏可见', layout.overlayVisible === true);

  await page.screenshot(path.join(ARTIFACTS, '375-start.png'));
  check('S3.5 375px 截图生成', existsSync(path.join(ARTIFACTS, '375-start.png')));
  check('S3.6 小屏控制台零 error', page.errors.length === 0, page.errors.join(' | '));

  await page.close();
}

async function scenarioDemo(browser, base) {
  console.log('\n[S4] demo 存档隔离（T-7 / FR-7.4）与埋点过滤（FR-8.2）');
  const page = await openPage(browser, `${base}/index.html`);
  await page.waitFor('!!window.NeonSerpent');

  await page.eval(`localStorage.setItem('neon-serpent:best', '120')`);
  await page.goto(`${base}/index.html?demo=1`);
  await page.waitFor(`NeonSerpent.mode() === 'playing'`, 10000);

  // 把蛇逼到右边界，并把另外两个方向用身体堵死，demo 寻路无路可走 → 撞墙
  await page.eval(`(() => {
    const s = NeonSerpent.state();
    s.score = 9999;
    s.snake = [{ x: 23, y: 12 }, { x: 23, y: 11 }, { x: 23, y: 13 }, { x: 22, y: 12 }];
    s.prevSnake = s.snake.map((c) => ({ ...c }));
    s.dir = s.nextDir = { x: 1, y: 0 };
  })()`);

  await page.waitFor(`NeonSerpent.mode() === 'over'`, 10000);

  const state = await page.eval(`(() => ({
    stored: localStorage.getItem('neon-serpent:best'),
    hud: document.getElementById('best').textContent,
    best: NeonSerpent.best(),
    score: NeonSerpent.state().score,
    all: NeonStats.events({ includeDemo: true }),
    real: NeonStats.events(),
  }))()`);

  check('S4.1 demo 结束后 storage 里的最高分没变', state.stored === '120', `stored=${state.stored}`);
  check('S4.2 demo 期间 HUD 最高分显示真实值', state.hud === '120', `hud=${state.hud}`);
  check('S4.3 内存里的 best 也没被 demo 分数顶掉', state.best === 120, `best=${state.best}`);
  check('S4.4 demo 事件带 demo=true', state.all.some((e) => e.demo === true) && state.all.length > 0);
  check('S4.5 默认导出不含 demo 事件（FR-8.2）', state.real.every((e) => e.demo === false));
  check('S4.6 死亡事件记录了归因', state.all.some((e) => e.e === 'death' && e.cause === 'wall'), JSON.stringify(state.all.find((e) => e.e === 'death')));
  check('S4.7 demo 流程控制台零 error', page.errors.length === 0, page.errors.join(' | '));

  await page.close();
}

async function scenarioPauseVisibility(browser, base) {
  console.log('\n[S5] 切后台自动暂停（FR-6.2）');
  const page = await openPage(browser, `${base}/index.html`);
  await page.waitFor('!!window.NeonSerpent');

  await page.key(' ');
  await page.waitFor(`NeonSerpent.mode() === 'playing'`);

  await page.eval(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));`);
  await page.waitFor(`NeonSerpent.mode() === 'paused'`, 3000);
  check('S5.1 隐藏页面自动暂停', true);

  await page.eval(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));`);
  await sleep(200);
  const mode = await page.eval('NeonSerpent.mode()');
  check('S5.2 返回页面仍处于暂停（不自动开局）', mode === 'paused', `mode=${mode}`);

  await page.close();
}

async function scenarioOgShot(browser, base) {
  console.log('\n[S6] 1200×630 OG 封面');
  const page = await openPage(browser, `${base}/index.html?demo=1`, {
    width: 1200, height: 630, deviceScaleFactor: 1,
  });
  await page.waitFor('!!window.NeonSerpent', 15000);

  // 只为截图用的版面微调：放大棋盘、隐藏页脚
  await page.eval(`(() => {
    const style = document.createElement('style');
    style.textContent = 'body{padding:10px!important}.stage{width:min(100%,470px)!important}.foot{display:none!important}';
    document.head.appendChild(style);
  })()`);

  await page.waitFor(`NeonSerpent.state().score >= 60`, 25000).catch(() => {});
  await sleep(400);

  const target = CAPTURE ? path.join(ROOT, 'assets', 'og-cover.png') : path.join(ARTIFACTS, 'og-cover.png');
  await page.screenshot(target);
  check('S6.1 OG 截图生成', existsSync(target), target);

  const score = await page.eval('NeonSerpent.state().score');
  check('S6.2 demo 自动寻路能吃分', score > 0, `score=${score}`);

  await page.close();
}

async function scenarioDemoSoak(browser, base) {
  console.log('\n[S7] demo 长跑 31s（FR-8.1）');
  const page = await openPage(browser, `${base}/index.html?demo=1`);
  await page.waitFor(`NeonSerpent.mode() === 'playing'`, 10000);
  await sleep(31000);

  const state = await page.eval(`({ mode: NeonSerpent.mode(), score: NeonSerpent.state().score, steps: NeonSerpent.state().eaten })`);
  check('S7.1 demo 无输入 30s 仍存活', state.mode === 'playing', `mode=${state.mode}`);
  check('S7.2 demo 30s 内得分 > 0', state.score > 0, `score=${state.score}`);
  check('S7.3 demo 长跑控制台零 error', page.errors.length === 0, page.errors.join(' | '));

  await page.close();
}

/* --------------------------------- 主流程 -------------------------------- */

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchBrowser();
  console.log(`浏览器：${path.basename(browser.exe)} · 站点：${base}`);

  try {
    await scenarioLoad(browser, base);
    await scenarioKeyboard(browser, base);
    await scenarioMobile(browser, base);
    await scenarioDemo(browser, base);
    await scenarioPauseVisibility(browser, base);
    await scenarioOgShot(browser, base);
    if (process.argv.includes('--soak')) await scenarioDemoSoak(browser, base);
  } finally {
    browser.cdp.close();
    browser.child.kill();
    server.close();
    await sleep(200);
    try { rmSync(browser.userDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(48)}`);
  console.log(`合计 ${results.length} 项 · 通过 ${results.length - failed.length} · 失败 ${failed.length}`);

  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  ✖ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('PASS: 端到端验收全部通过');
}

main().catch((error) => {
  console.error('端到端验收异常终止：');
  console.error(error);
  process.exit(1);
});
