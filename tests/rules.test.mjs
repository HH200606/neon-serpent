/* =============================================================================
   规则层单测 · FR-0.2 / T-1 ~ T-6
   跑法：node --test "tests/*.test.mjs"
   ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';
import rules from '../js/rules.js';

const C = rules.CONFIG;

/** 确定性 rng：总是挑“第一个”空位，测试里再手动摆放果实。 */
const fixedRng = () => 0;

const mk = () => rules.createState({ rng: fixedRng });
const tick = (s, now) => rules.tick(s, { now, rng: fixedRng });
const head = (s) => s.snake[0];

/** 把果实摆到蛇头正前方，保证下一步必吃到。 */
function fruitAhead(s) {
  const h = head(s);
  s.fruit = { x: h.x + s.dir.x, y: h.y + s.dir.y };
  return s.fruit;
}

/* ------------------------------- T-1 ------------------------------------- */

test('T-1 连吃 5 个果实，得分增量是 10/20/30/40/50', () => {
  const s = mk();
  const gains = [];

  for (let i = 0; i < 5; i += 1) {
    fruitAhead(s);
    const before = s.score;
    const result = tick(s, i * 100);
    assert.equal(result.ate, 'fruit');
    gains.push(s.score - before);
  }

  assert.deepEqual(gains, [10, 20, 30, 40, 50]);
  assert.equal(s.score, 150);
  assert.equal(s.combo, 5);
});

/* ------------------------------- T-2 ------------------------------------- */

test('T-2 连击超过 5 次后封顶 ×5', () => {
  const s = mk();

  for (let i = 0; i < 6; i += 1) {
    fruitAhead(s);
    tick(s, i * 100);
  }

  assert.equal(s.combo, 5);
  assert.equal(s.score, 150 + 50);
});

/* ------------------------------- T-3 ------------------------------------- */

test('T-3 间隔超过 2600ms 再吃，倍率回到 ×1', () => {
  const s = mk();

  fruitAhead(s);
  tick(s, 0);
  fruitAhead(s);
  tick(s, 100);
  assert.equal(s.combo, 2);

  fruitAhead(s);
  const before = s.score;
  // 上一次吃在 t=100，这里间隔 2700ms
  tick(s, 2800);

  assert.equal(s.combo, 1);
  assert.equal(s.score - before, 10);
});

test('暂停平移计时器后，连击窗口不被暂停吃掉（FR-6.1）', () => {
  const s = mk();
  fruitAhead(s);
  tick(s, 0);
  assert.equal(s.combo, 1);

  rules.shiftTimers(s, 3000); // 暂停 3 秒
  fruitAhead(s);
  const result = tick(s, 3200); // 真实时间过了 3200ms，有效间隔只有 200ms

  assert.equal(s.combo, 2);
  assert.equal(result.score, 30);
});

test('暂停平移计时器后，金果实寿命不被暂停吃掉', () => {
  const s = mk();
  const h = head(s);
  s.bonus = { x: h.x + 1, y: h.y, bornAt: 0, dieAt: 9000 };

  assert.equal(rules.shiftTimers(s, 5000), true);
  assert.equal(s.bonus.dieAt, 14000);
  assert.equal(s.bonus.bornAt, 5000);
  assert.equal(rules.expireBonus(s, 13000), false);
  assert.equal(rules.expireBonus(s, 14001), true);
});

test('平移计时器对无效增量和空状态是 no-op', () => {
  const s = mk();
  assert.equal(s.lastEatAt, null);
  assert.equal(rules.shiftTimers(s, 0), false);
  assert.equal(rules.shiftTimers(s, -10), false);
  assert.equal(s.lastEatAt, null);

  fruitAhead(s);
  tick(s, 100);
  assert.equal(rules.shiftTimers(s, 500), true);
  assert.equal(s.lastEatAt, 600);
});

test('连击窗口边界：恰好 2600ms 仍算连击', () => {
  const s = mk();
  fruitAhead(s);
  tick(s, 100);
  fruitAhead(s);
  const before = s.score;
  tick(s, 2700);

  assert.equal(s.combo, 2);
  assert.equal(s.score - before, 20);
});

test('连击窗口过期后 refreshCombo 把倍率复位（且只报一次）', () => {
  const s = mk();
  fruitAhead(s);
  tick(s, 0);
  fruitAhead(s);
  tick(s, 100);
  assert.equal(s.combo, 2);

  assert.equal(rules.refreshCombo(s, 100 + C.comboWindow - 1), false);
  assert.equal(s.combo, 2);
  assert.equal(rules.refreshCombo(s, 100 + C.comboWindow + 1), true);
  assert.equal(s.combo, 1);
  assert.equal(rules.refreshCombo(s, 100 + C.comboWindow + 2), false);
});

/* ------------------------------- T-4 ------------------------------------- */

test('T-4 步长序列：n=0→150、10→120、20→96、34→76', () => {
  assert.equal(rules.stepMsFor(0), 150);
  assert.equal(rules.stepMsFor(10), 120);
  assert.equal(rules.stepMsFor(20), 96);
  assert.equal(rules.stepMsFor(34), 76);
  assert.equal(rules.stepMsFor(50), 76, '76ms 封顶不再加速');
  assert.ok(rules.stepMsFor(34) >= C.minStep);
});

/* ------------------------------- T-5 ------------------------------------- */

test('T-5 反向输入被拒，方向不变', () => {
  const s = mk();
  assert.equal(s.dir, rules.DIRS.right);

  assert.equal(rules.queueDirection(s, 'left'), false);
  assert.equal(s.dir, rules.DIRS.right);
  assert.equal(s.nextDir, rules.DIRS.right);
});

test('同一逻辑步内只接受第一个有效转向', () => {
  const s = mk();
  assert.equal(rules.queueDirection(s, 'up'), true);
  assert.equal(rules.queueDirection(s, 'left'), false, '第二个转向应被忽略');
  assert.equal(s.nextDir, rules.DIRS.up);

  tick(s, 0);
  assert.equal(s.dir, rules.DIRS.up);
  assert.equal(rules.queueDirection(s, 'left'), true, '下一步恢复接收转向');
});

test('转向排队不依赖方向对象的身份', () => {
  const s = mk();
  // 外部只替换 dir（新对象）时，仍应能正常排队转向
  s.dir = { x: 1, y: 0 };
  s.nextDir = { x: 1, y: 0 };

  assert.equal(rules.queueDirection(s, 'up'), true);
  tick(s, 0);
  assert.equal(s.dir, rules.DIRS.up);
  assert.equal(rules.queueDirection(s, 'left'), true);
});

/* ------------------------------- T-6 ------------------------------------- */

test('T-6 撞墙返回 wall 并结束', () => {
  const s = mk();
  s.snake = [{ x: 23, y: 12 }, { x: 22, y: 12 }, { x: 21, y: 12 }];
  s.prevSnake = s.snake.map((c) => ({ ...c }));

  const result = tick(s, 0);

  assert.equal(result.died, 'wall');
  assert.equal(s.status, 'dead');
  assert.equal(s.deathCause, 'wall');
});

test('T-6 咬到自己返回 self 并结束', () => {
  const s = mk();
  // 头 (5,5) 向下走，撞上身体第 2 节 (5,6)
  s.snake = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }];
  s.prevSnake = s.snake.map((c) => ({ ...c }));
  s.dir = rules.DIRS.down;
  s.nextDir = rules.DIRS.down;

  const result = tick(s, 0);

  assert.equal(result.died, 'self');
  assert.equal(s.deathCause, 'self');
  assert.equal(s.snake.length, 4, '死亡后身体不再变化');
});

test('死亡后继续 tick 不再推进', () => {
  const s = mk();
  s.snake = [{ x: 23, y: 12 }, { x: 22, y: 12 }];
  s.dir = rules.DIRS.right;
  s.nextDir = rules.DIRS.right;
  tick(s, 0);

  const frozen = s.snake.map((c) => ({ ...c }));
  const result = tick(s, 100);

  assert.equal(result.died, null);
  assert.deepEqual(s.snake, frozen);
});

/* ----------------------------- FR-1.1 / 1.2 ------------------------------ */

test('开局蛇长 3、居中、向右，果实不在蛇身上', () => {
  const s = mk();

  assert.equal(s.snake.length, 3);
  assert.deepEqual(s.snake[0], { x: 12, y: 12 });
  assert.deepEqual(s.snake[1], { x: 11, y: 12 });
  assert.deepEqual(s.snake[2], { x: 10, y: 12 });
  assert.equal(s.dir, rules.DIRS.right);
  assert.equal(s.status, 'playing');
  assert.equal(s.score, 0);
  assert.equal(s.combo, 1);
  assert.equal(s.stepMs, C.baseStep);

  const onSnake = s.snake.some((c) => c.x === s.fruit.x && c.y === s.fruit.y);
  assert.equal(onSnake, false);
});

test('吃到果实长度 +1，没吃到长度不变', () => {
  const s = mk();
  tick(s, 0);
  assert.equal(s.snake.length, 3, '空走一步长度不变');

  fruitAhead(s);
  const len = s.snake.length;
  tick(s, 100);
  assert.equal(s.snake.length, len + 1);
});

test('不吃果实时，蛇头可以进入刚腾出的尾巴格', () => {
  const s = mk();
  // 头 (5,5) 向下，尾巴在 (5,6)：尾巴这一步会移走
  s.snake = [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }, { x: 5, y: 6 }];
  s.prevSnake = s.snake.map((c) => ({ ...c }));
  s.dir = rules.DIRS.down;
  s.nextDir = rules.DIRS.down;
  s.fruit = { x: 0, y: 0 };

  const result = tick(s, 0);

  assert.equal(result.died, null);
  assert.deepEqual(s.snake[0], { x: 5, y: 6 });
  assert.equal(s.snake.length, 4);
});

/* ------------------------------- FR-3 ------------------------------------ */

test('金果实：每 5 个普通果实出现 1 个，存活 9000ms', () => {
  const s = mk();

  for (let i = 0; i < 4; i += 1) {
    fruitAhead(s);
    tick(s, i * 100);
  }
  assert.equal(s.bonus, null, '第 4 个之后还没有金果实');

  fruitAhead(s);
  tick(s, 400);
  assert.ok(s.bonus, '第 5 个之后出现金果实');
  assert.equal(s.bonus.dieAt - s.bonus.bornAt, C.bonusLife);
  assert.ok(s.bonus.x !== s.fruit.x || s.bonus.y !== s.fruit.y, '不与普通果实重叠');
  const onSnake = s.snake.some((c) => c.x === s.bonus.x && c.y === s.bonus.y);
  assert.equal(onSnake, false, '不落在蛇身上');
});

test('金果实 +30 × 倍率（连吃两个后吃金果实得 90）', () => {
  const s = mk();
  fruitAhead(s);
  tick(s, 0);
  fruitAhead(s);
  tick(s, 100);
  assert.equal(s.combo, 2);

  const h = head(s);
  s.bonus = { x: h.x + 1, y: h.y, bornAt: 0, dieAt: 10_000 };
  const before = s.score;
  const result = tick(s, 200);

  assert.equal(result.ate, 'bonus');
  assert.equal(s.combo, 3);
  assert.equal(s.score - before, 30 * 3);
  assert.equal(s.bonus, null, '吃到后消失');
});

test('金果实不吃也不计入普通果实数（不加速）', () => {
  const s = mk();
  const h = head(s);
  s.bonus = { x: h.x + 1, y: h.y, bornAt: 0, dieAt: 10_000 };
  tick(s, 0);

  assert.equal(s.eaten, 0);
  assert.equal(s.stepMs, C.baseStep);
});

test('金果实 9000ms 后过期：不可吃、也不再占格子', () => {
  const s = mk();
  const h = head(s);
  s.bonus = { x: h.x + 1, y: h.y, bornAt: 0, dieAt: 9000 };

  assert.equal(rules.expireBonus(s, 8999), false);
  assert.equal(rules.expireBonus(s, 9001), true);
  assert.equal(s.bonus, null);

  const before = s.score;
  const result = tick(s, 9002);
  assert.equal(result.ate, null);
  assert.equal(s.score, before);
});

/* ----------------------------- FR-1.4 边界 -------------------------------- */

test('果实生成永不落在蛇身或金果实上', () => {
  const s = mk();
  for (let i = 0; i < 40; i += 1) {
    s.fruit = null;
    rules.placeFruit(s, fixedRng);
    assert.ok(s.fruit, '还有空位时应生成成功');
    const onSnake = s.snake.some((c) => c.x === s.fruit.x && c.y === s.fruit.y);
    const onBonus = !!s.bonus && s.bonus.x === s.fruit.x && s.bonus.y === s.fruit.y;
    assert.equal(onSnake || onBonus, false);
  }
});

test('棋盘填满时 freeCells 为空，生成返回 null 且不崩溃', () => {
  const s = mk();
  s.snake = [];
  for (let y = 0; y < s.rows; y += 1) {
    for (let x = 0; x < s.cols; x += 1) s.snake.push({ x, y });
  }
  s.fruit = null;
  s.bonus = null;

  assert.equal(rules.freeCells(s).length, 0);
  assert.equal(rules.placeFruit(s, fixedRng), null);
  assert.equal(rules.placeBonus(s, 0, fixedRng), null);
  assert.equal(s.fruit, null);
});

/* ------------------------------ FR-1.5 ----------------------------------- */

test('渲染插值进度在 0..1 之间并被钳制', () => {
  assert.equal(rules.progress(0, 150), 0);
  assert.equal(rules.progress(75, 150), 0.5);
  assert.equal(rules.progress(150, 150), 1);
  assert.equal(rules.progress(999, 150), 1);
  assert.equal(rules.progress(-5, 150), 0);
  assert.equal(rules.progress(50, 0), 1);
});
