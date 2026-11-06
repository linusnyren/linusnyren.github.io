import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, steer, tick, sanitize, electHost, addToFame, autopilot, COLS } from './engine.js';

const fixed = () => 0;

test('queues quick turns but rejects reversals and repeats', () => {
  const s = newGame(null, fixed);
  assert.equal(steer(s, 'left', 'a'), false);
  assert.equal(steer(s, 'right', 'a'), false);
  assert.ok(steer(s, 'up', 'a'));
  assert.ok(steer(s, 'left', 'b'));
  assert.equal(steer(s, 'right', 'c'), false);
  tick(s); tick(s);
  assert.equal(s.dir, 'left');
  assert.deepEqual(s.crew, ['a', 'b']);
});

test('eating grows the dog and scores', () => {
  const s = newGame(null, fixed);
  const [hx, hy] = s.snake[0];
  s.food = [hx + 1, hy];
  assert.equal(tick(s), 'eat');
  assert.equal(s.score, 1);
  assert.equal(s.snake.length, 4);
});

test('wall and self collisions end the game, blaming the last steerer', () => {
  const s = newGame(null, fixed);
  s.food = [0, 0];
  let ev;
  for (let i = 0; i < COLS && ev !== 'die'; i++) ev = tick(s);
  assert.equal(ev, 'die');
  assert.equal(s.death.cause, 'wall');

  const t = newGame(null, fixed);
  t.snake = [[5, 5], [4, 5], [4, 6], [5, 6], [6, 6], [6, 5]];
  t.food = [0, 0];
  steer(t, 'down', 'oops');
  assert.equal(tick(t), 'die');
  assert.deepEqual(t.death, { cause: 'self', by: 'oops' });
});

test('chasing your own tail is legal', () => {
  const s = newGame(null, fixed);
  s.snake = [[5, 5], [5, 6], [4, 6], [4, 5]];
  s.dir = 'up';
  s.food = [0, 0];
  steer(s, 'left');
  assert.equal(tick(s), 'move');
});

test('sanitize rejects junk and strips unknown fields', () => {
  assert.equal(sanitize(null), null);
  assert.equal(sanitize({ snake: 'x' }), null);
  assert.equal(sanitize({ snake: [[1, 1], [999, 1]], dir: 'up', status: 'playing' }), null);
  const s = sanitize({ snake: [[1, 1], [0, 1]], dir: 'right', status: 'playing', evil: '<script>', crew: ['a'.repeat(99), 5] });
  assert.equal(s.evil, undefined);
  assert.deepEqual(s.crew, ['a'.repeat(20)]);
});

test('host election prefers oldest active peer and ignores stale ones', () => {
  const now = 10_000;
  const peers = new Map([
    ['old', { id: 'old', joined: 1, active: false, seen: now }],
    ['mid', { id: 'mid', joined: 2, active: true, seen: now }],
    ['ghost', { id: 'ghost', joined: 0, active: true, seen: 0 }],
  ]);
  assert.equal(electHost(peers, now), 'mid');
  peers.get('mid').active = false;
  assert.equal(electHost(peers, now), 'old');
});

test('hall of fame keeps the top scores', () => {
  let f = [];
  for (const score of [3, 9, 0, 5]) f = addToFame(f, { score, crew: [], at: score }, 2);
  assert.deepEqual(f.map((e) => e.score), [9, 5]);
});

test('autopilot survives and eats until a human grabs the leash', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const s = newGame(null, rnd);
  for (let i = 0; i < 400 && s.status === 'playing'; i++) {
    const d = autopilot(s);
    if (d !== s.dir) steer(s, d, null);
    tick(s, rnd);
  }
  assert.equal(s.status, 'playing');
  assert.ok(s.score >= 10, `score ${s.score}`);
  assert.equal(s.auto, true);
  steer(s, s.dir === 'up' || s.dir === 'down' ? 'left' : 'up', 'human');
  tick(s, rnd);
  assert.equal(s.auto, false);
});
