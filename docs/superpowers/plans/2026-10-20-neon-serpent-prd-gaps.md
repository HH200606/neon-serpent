# Neon Serpent · PRD 一期补强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 PRD v1.1「一期补强」里的 P0 缺口补齐：可测试的纯规则层 + 单测、demo 存档隔离、本地聚合埋点、OG 修复、自动化验收脚本，并顺手落地两个低成本 P1（暂停挂音、可访问性边界声明）。

**Architecture:** 逻辑从 `js/game.js` 的 IIFE 里抽出为 UMD 纯模块 `js/rules.js`（Node 与浏览器共用，不碰 `window`/`document`/`ctx`）；持久化抽成 `js/store.js`（注入 storage，demo 会话写入为 no-op）；埋点抽成 `js/analytics.js`（注入 storage/clock，本地环形缓冲）。`game.js` 只保留渲染、音效、输入、界面状态，并成为三个模块的装配层。测试零依赖：`node --test` 跑单测，`tools/e2e.mjs` 用 Node 内置 WebSocket 直连 Edge headless 的 CDP 做端到端验收。

**Tech Stack:** 原生 ES2020（无构建、无依赖）、Canvas 2D、WebAudio、`node --test`、Edge headless + CDP。

**Spec:** `docs/PRD.md`（v1.1，唯一事实源）

## Global Constraints

- 零依赖、零构建、可离线：站点不发任何第三方请求（NFR-9，AC-4）；首屏 html+css+js ≤60KB（NFR-3，AC-2）。
- 规则层不得引用 `window` / `document` / `ctx.` / `AudioContext`（FR-0.1、FR-0.3），必须能在 Node 下 `require`。
- 步长 `step(n) = max(76, 150 × 0.978^n)`，取整到毫秒：n=0→150、10→120、20→96、34→76（T-4）。
- 得分 `score += base × min(5, combo)`；普通 10、金果实 30；窗口 2600ms；上限 ×5（FR-2.x、FR-3.2）。
- 金果实：每 5 个普通果实一个、存活 9000ms（FR-3.1、FR-3.3）。
- 滑动阈值 24px（FR-5.3）；禁止 180° 反向，且一个逻辑步内只接受首个有效转向（FR-5.2、9.2）。
- localStorage 键：`neon-serpent:best`、`neon-serpent:muted`，新增 `neon-serpent:events`；所有读写 try/catch（FR-7.3、FR-7.5）。
- demo 会话（`?demo=1`）不得写 `neon-serpent:best`，HUD 最高分显示真实值；事件带 `demo:true`（FR-7.4、FR-8.2）。
- 文案用中文，与现有界面语气一致；提交信息用英文 `type: subject`。

## Review Focus

- 一步之内的两次快速转向：玩家按「上」后立刻按「左」，第二个键必须被拒（不是覆盖），否则会出现瞬间掉头。
- 蛇尾与成长：这一步吃到果实时尾巴不动，头部进入尾巴格不算自咬；不吃果实时进入尾巴格合法。
- 金果实与普通果实同时在同一格生成（或棋盘只剩 1 格）：生成器不得死循环、不得重叠。
- demo 玩家连玩 3 局后刷新：真实最高分必须完全没被 demo 分数顶上去（当前缺陷的回归点）。
- 暂停恢复：暂停期间不残留音效，恢复后不跳步（`acc` 不被暂停时长灌满）。

---

### Task 1: 纯规则模块 `js/rules.js`

**Files:**
- Create: `js/rules.js`
- Create: `tests/rules.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `NeonRules.CONFIG` = `{cols:24, rows:24, baseStep:150, minStep:76, speedUp:0.978, comboWindow:2600, comboMax:5, fruitScore:10, bonusScore:30, bonusEvery:5, bonusLife:9000, swipeThreshold:24}`
  - `NeonRules.DIRS` = `{up:{x:0,y:-1}, down:{x:0,y:1}, left:{x:-1,y:0}, right:{x:1,y:0}}`
  - `NeonRules.stepMsFor(eaten: number) -> number`
  - `NeonRules.createState({rng?: () => number}) -> State`
  - `NeonRules.queueDirection(state, name: 'up'|'down'|'left'|'right') -> boolean`
  - `NeonRules.tick(state, {now: number, rng?: () => number}) -> {ate: 'fruit'|'bonus'|null, died: 'wall'|'self'|null, score: number, combo: number, stepMs: number}`
  - `NeonRules.expireBonus(state, now: number) -> boolean`
  - `NeonRules.refreshCombo(state, now: number) -> boolean`（连击过期时把 `combo` 复位为 1，返回是否发生）
  - `NeonRules.freeCells(state, {includeFruit?: boolean}) -> Array<{x,y}>`
  - `NeonRules.progress(acc: number, stepMs: number) -> number`（0..1，供渲染插值）
  - `State`: `{cols, rows, snake:[{x,y}], prevSnake:[{x,y}], dir, nextDir, fruit:{x,y}|null, bonus:{x,y,bornAt,dieAt}|null, score, combo, eaten, stepMs, lastEatAt, status:'playing'|'dead', deathCause:null|'wall'|'self'}`

- [ ] **Step 1: 写失败的测试**

```js
// tests/rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import rules from '../js/rules.js';

const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };
const play = (state, now) => rules.tick(state, { now, rng: () => 0 });
const putFruit = (state, x, y) => { state.fruit = { x, y }; };
const putHead = (state, x, y) => { state.snake = [{ x, y }, { x: x - 1, y }, { x: x - 2, y }]; state.prevSnake = state.snake.map(s => ({ ...s })); };

test('T-1 连吃 5 个果实得 10/20/30/40/50', () => { ... });
// 断言：五次 eat 后每次 score 增量分别是 10,20,30,40,50
test('T-2 连击 6 次封顶 ×5', ...);           // 第 6 个仍是 +50
test('T-3 间隔 2700ms 后再吃回到 ×1', ...);   // 本次 +10
test('T-4 步长序列 n=0/10/20/34 → 150/120/96/76', ...);
test('T-5 反向输入被拒，方向不变', ...);       // queueDirection('left') === false
test('T-6 撞墙/自咬返回死亡原因', ...);        // died 'wall' / 'self'，status 'dead'
test('一个逻辑步内只接受首个转向', ...);       // 先 up 成功，再 left 被拒
test('初始蛇长 3、居中、向右，果实不在蛇身上', ...);
test('吃到果实长度 +1，未吃到长度不变', ...);
test('成长时头部进入尾巴格不算自咬', ...);
test('金果实每 5 个普通果实出现，+30 × 倍率', ...);
test('金果实 9000ms 后过期不可吃，且不阻挡普通果实生成', ...);
test('棋盘填满时 freeCells 为空且生成不崩溃', ...);
test('进度插值 0..1 且被钳制', ...);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/`
Expected: FAIL — `Cannot find module '../js/rules.js'`

- [ ] **Step 3: 实现 UMD 纯模块**

`js/rules.js` 顶部用 UMD 包装（`module.exports` 优先，否则挂 `globalThis.NeonRules`），内部只做纯计算：`stepMsFor` 用 `Math.max(minStep, Math.round(baseStep * speedUp ** eaten))`；`tick` 先记录 `prevSnake`、`dir = nextDir`、算新头、越界→`dead/wall`、按 `growing` 决定是否检查尾巴做自咬判定、再 `unshift/pop`、结算得分与连击、重生果实、按 `eaten % 5` 生成金果实。不得出现 `window`/`document`/`ctx`/`AudioContext`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/`
Expected: PASS，`# pass ≥ 14`

- [ ] **Step 5: 提交**

```bash
git add js/rules.js tests/rules.test.mjs
git commit -m "feat(rules): extract DOM-free game rules with unit tests"
```

---

### Task 2: 存档层 `js/store.js`（T-7 / FR-7.4）

**Files:**
- Create: `js/store.js`
- Create: `tests/store.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `NeonStore.createStore(storage, {demo?: boolean, prefix?: string}) -> {readBest(): number, writeBest(v: number): boolean, readMuted(): boolean, writeMuted(v: boolean): boolean}`
  - `demo:true` 时 `writeBest` 直接返回 `false` 且不触碰 storage；`readBest` 仍读真实值。

- [ ] **Step 1: 写失败的测试**

```js
test('T-7 demo 会话写最高分是 no-op，存储值不变', ...);   // 预置 120，写 900，仍 120，返回 false
test('非 demo 会话写入最高分', ...);
test('静音状态读写往返', ...);
test('storage 抛异常时不崩溃（隐私模式）', ...);          // getItem/setItem 都 throw
test('存储里是垃圾值时读作 0 / false', ...);
```

- [ ] **Step 2: 跑测试确认失败** — `node --test tests/store.test.mjs` → `Cannot find module '../js/store.js'`

- [ ] **Step 3: 实现** — 同 UMD 包装；所有读写包 try/catch；`readBest` 仅接受有限正数。

- [ ] **Step 4: 跑测试确认通过** — `node --test tests/` → PASS

- [ ] **Step 5: 提交** — `git commit -m "feat(store): demo-safe persistence layer, fixes FR-7.4 storage leak"`

---

### Task 3: 埋点 `js/analytics.js`（第 11 节 / FR-8.2）

**Files:**
- Create: `js/analytics.js`
- Create: `tests/analytics.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `NeonAnalytics.createAnalytics({storage, demo?: boolean, clock?: () => number, maxEvents?: number}) -> {track(name: string, fields?: object): boolean, readAll(opts?: {includeDemo?: boolean}): object[], exportJson(): string, clear(): void}`
  - 合法事件名与字段见 PRD 11.1；未知事件名丢弃并返回 `false`；每条记录形如 `{e: name, ts: number, demo: boolean, ...fields}`；环形上限默认 500，超出丢最旧；storage 异常时退化为内存数组。

- [ ] **Step 1: 写失败的测试**

```js
test('记录合法事件，带 ts 与 demo 标记', ...);
test('未知事件名被丢弃', ...);
test('readAll({includeDemo:false}) 过滤掉 demo 事件', ...);   // FR-8.2
test('超过上限时丢最旧事件', ...);                            // maxEvents: 3
test('storage 抛异常时仍能记录，exportJson 可用', ...);
test('exportJson 输出可解析的 JSON 数组', ...);
```

- [ ] **Step 2: 跑测试确认失败** — `node --test tests/analytics.test.mjs`

- [ ] **Step 3: 实现** — `EVENT_FIELDS` 白名单（`page_view`/`run_start`/`fruit_eaten`/`swipe`/`death`/`run_end`/`retry`/`mute_toggle`/`frame_stats`）；只保留白名单字段，其余忽略。

- [ ] **Step 4: 跑测试确认通过** — `node --test tests/` → PASS

- [ ] **Step 5: 提交** — `git commit -m "feat(analytics): local-only event log with demo flag"`

---

### Task 4: `js/game.js` 装配层（FR-7.4、FR-8.2、FR-6.3）

**Files:**
- Modify: `js/game.js`（全量重写，保留绘制/音效/输入，删除内联规则）
- Modify: `index.html:78`（按顺序引入 `rules.js`、`store.js`、`analytics.js`、`game.js`）

**Interfaces:**
- Consumes: `NeonRules.*`、`NeonStore.createStore`、`NeonAnalytics.createAnalytics`。
- Produces: 全局 `window.NeonStats = {events(opts), export()}`（导出 JSON 下载）、`window.NeonSerpent = {game, rules}`（只读调试句柄，供 e2e 读状态）。

- [ ] **Step 1: 先写端到端断言（后续 Task 6 的 harness 会跑）** — 在 `tests/` 之外的 `tools/e2e.mjs` 场景表里登记：`demo=1` 结束一局后 `localStorage['neon-serpent:best']` 不变；非 demo 得分后 best 增加；页面无 `console.error`。

- [ ] **Step 2: 重写 game.js 的规则部分**

移除 `CFG`/`DIRS`/`step()`/`award()`/`randomEmptyCell()`/`hitsBody()`，改为：`const R = NeonRules; const game = R.createState({rng});` 并保留 `mode/acc/particles/shake/dieAt` 等视图字段。关键点：
  - `award` 只做粒子/HUD；得分与连击由 `R.tick` 返回。
  - `game.best` 只在 `!isDemo` 且 `score > best` 时更新并 `store.writeBest`（FR-7.4）。
  - `togglePause` 里 `audio.ctx.suspend()/resume()`；恢复时把 `acc` 归零避免跳步（FR-6.3、FR-6.1）。
  - 埋点：`page_view`（加载）、`run_start`（开局）、`fruit_eaten`（吃到，含 `type/combo/score/stepMs`）、`swipe`（含 `ignored/dist`）、`death`（含 `cause/score/durationSec/comboMax`）、`run_end`、`retry`、`mute_toggle`、`frame_stats`（每 60 帧，p95 与掉帧率）。
  - 局内时长用「活跃毫秒」累加，暂停不计（M-3 口径）。

- [ ] **Step 3: 本地起服务手动冒烟** — `python -m http.server 8123`（PowerShell 后台作业）+ Edge 打开，确认开局/吃果实/暂停/结束四态无报错。

- [ ] **Step 4: 提交** — `git commit -m "refactor(game): wire rules/store/analytics, isolate demo best, suspend audio on pause"`

---

### Task 5: 静态验收脚本（AC-2 / AC-4）

**Files:**
- Create: `tools/check-size.mjs`
- Create: `tools/check-links.mjs`
- Create: `package.json`（仅 scripts，无 dependencies；`"private": true`）

**Interfaces:**
- Produces: `node tools/check-size.mjs` → 打印各文件字节数与合计，超 60KB 退出码 1；`node tools/check-links.mjs` → 扫描 `index.html`、`css/**`、`js/**` 里的 `http(s)://`，白名单为 `github.com/HH200606/`、`hh200606.github.io/neon-serpent/`，出现站外域名退出码 1。

- [ ] **Step 1: 写脚本并先跑出失败**

Run: `node tools/check-size.mjs` → 目前应 PASS 但阈值可被 `--max=1000` 触发失败，用它验证脚本能报警。
Run: `node tools/check-links.mjs` → 当前 `index.html` 的 `og:image` 是相对路径不报警；临时给 `css/style.css` 加一行 `http://example.com/x` 验证能报错，验证后删除。

- [ ] **Step 2: 正式接入** — `package.json` scripts：`test`、`check:size`、`check:links`、`e2e`、`verify`（串联全部）。

- [ ] **Step 3: 跑** `node tools/check-size.mjs`、`node tools/check-links.mjs` → 均 PASS（退出码 0）。

- [ ] **Step 4: 提交** — `git commit -m "test(tools): add bundle-size and external-link acceptance checks"`

---

### Task 6: 端到端验收 `tools/e2e.mjs`（AC-3 / AC-5 / AC-6 / NFR-5）

**Files:**
- Create: `tools/e2e.mjs`
- Create: `tests/e2e-cases.mjs`（场景与断言，供 harness 引用）

**Interfaces:**
- Consumes: `msedge --headless=new --remote-debugging-port=0`（通过 `--user-data-dir` 临时目录 + stderr 里的 `DevToolsActivePort` 取端口），Node 内置 `WebSocket`。
- Produces: `node tools/e2e.mjs` → 逐场景 PASS/FAIL 摘要，失败退出码 1，产物截图写到 `artifacts/`（`.gitignore` 忽略）。

场景：
1. 加载 `index.html`：无 `console.error`/`pageerror`；`#overlay` 可见；标题、canvas 非空。
2. 键盘开局（Space）→ 按方向键 → 分数在 3 秒内增加（用 `?speed=fast`？不要新增参数；改用 `?demo=1` 之外的确定性方式：键盘开局后把 `#score` 与初值比较，最长等 6 秒）。
3. 375×667 视口：`document.documentElement.scrollWidth <= 375 + 1`；`.dpad` 可见（模拟 coarse pointer 需 CDP `Emulation.setTouchEmulationEnabled` + `setDeviceMetricsOverride`）。
4. `?demo=1`：预置 `localStorage['neon-serpent:best']='120'`，跑 8 秒后读取，仍为 `120`，且 HUD `#best` 仍显示 120（FR-7.4）。
5. 非 demo：吃到一个果实后 best 写入 storage（数值 > 0）。
6. 暂停：Space 后 `#ovTitle` 为「已暂停」，再 Space 恢复。
7. 1200×630 视口截图存 `assets/og-cover.png`（同时断言生成成功）。

- [ ] **Step 1: 写 harness 并先跑** — 预期场景 4 当前 FAIL（demo 污染），其余通过或暴露真问题。
- [ ] **Step 2: 修到全绿**（属于 Task 4 的实现范围）。
- [ ] **Step 3: 生成 `assets/og-cover.png` 并目视检查**（`read_image`）。
- [ ] **Step 4: 提交** — `git commit -m "test(e2e): headless CDP acceptance suite with demo regression"`

---

### Task 7: 页面元信息与文档收尾（FR-11.1、FR-10.5）

**Files:**
- Modify: `index.html`（`og:image` 绝对地址 + `og:url` + `og:image:width/height` + 页脚可访问性边界声明）
- Modify: `README.md`（测试命令、埋点导出、结构更新）
- Modify: `docs/PRD.md`（状态列改为实际值、变更记录 v1.2、`version: 1.2.0`）

- [ ] **Step 1: 改 `index.html`** — `og:image` 指向 `https://hh200606.github.io/neon-serpent/assets/og-cover.png`，补 `<meta property="og:url" content="https://hh200606.github.io/neon-serpent/">`、`og:image:width=1200`、`og:image:height=630`、`og:site_name`；页脚加一句「核心玩法为视觉向，canvas 不提供读屏替代」。
- [ ] **Step 2: 跑** `node tools/check-links.mjs` → 仍 PASS（白名单域名）。
- [ ] **Step 3: 更新 README / PRD 状态表** — 只改状态与新增命令，不改需求语义。
- [ ] **Step 4: 提交** — `git commit -m "docs: OG absolute URLs, a11y boundary, PRD status sync"`

---

### Task 8: 全量验证

- [ ] `node --test tests/` → 全绿，`# pass ≥ 26`
- [ ] `node tools/check-size.mjs` → 合计 ≤ 60KB
- [ ] `node tools/check-links.mjs` → 无站外引用
- [ ] `node tools/e2e.mjs` → 全部场景 PASS，截图正常
- [ ] `git status --short` → 仅预期文件
- [ ] 汇总：哪些 ID 从 not-implemented/defect 变为 implemented，哪些仍留待 V2

---

## 执行后记（2026-10-22 回填）

实际执行与上面计划的差异，留档以免下次按计划找文件时扑空：

- 没建 `tests/e2e-cases.mjs`：场景直接内联在 `tools/e2e.mjs`，每个场景一个独立 browser context，读起来更顺。
- Task 5/6 的脚本没有单独提交，随 `63c8ba7 refactor(game)` 一起进了历史；`git log -- tools/` 只能看到那一个提交。
- `window.NeonSerpent` 暴露 `{rules, state(), best(), mode(), audioState()}`，比计划里的 `{game, rules}` 更适合端到端断言。
- `createStore` 没做计划里的 `prefix` 选项（键名固定，测试也用不到）。
- e2e 多了 S7（`node tools/e2e.mjs --soak`）验证 FR-8.1：demo 无输入 31 秒仍存活且得分 > 0。
- 代码评审后追加修复：`run_end.isNewBest` 改为与开局记录比较（原先恒为 false）、暂停冻结连击窗口与金果实寿命（`NeonRules.shiftTimers`）、暂停期间不唤醒音频且静音冷启动不建实例、埋点 `readAll()`/`exportJson()` 默认过滤 demo、`frame_stats` 从 1s 降到 10s 一次、`check-links` 补协议相对地址、`safeStorage` 改为只读探测。
