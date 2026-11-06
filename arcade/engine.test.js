import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newWorld, addDog, removeDog, steer, tick, sanitize, wire, electHost, addToFame, COATS, RESPAWN_TICKS } from './engine.js';

const seeded = (seed = 7) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const place = (dog, snake, dir) => Object.assign(dog, { snake, dir, auto: false, alive: true });

test('every dog gets its own coat', () => {
  const s = newWorld(seeded());
  const ids = Array.from({ length: COATS.length }, (_, i) => `p${i}`);
  ids.forEach((id) => addDog(s, { id, name: id }, seeded()));
  assert.equal(new Set(s.dogs.map((d) => d.c)).size, COATS.length);
  removeDog(s, 'p3');
  assert.equal(addDog(s, { id: 'new', name: 'new' }).c, 3);
});

test('steering only affects your own dog and rejects reversals', () => {
  const s = newWorld();
  const a = place(addDog(s, { id: 'a', name: 'A' }), [[5, 5], [4, 5], [3, 5]], 'right');
  const b = place(addDog(s, { id: 'b', name: 'B' }), [[5, 15], [4, 15], [3, 15]], 'right');
  s.food = [];
  assert.equal(steer(s, 'a', 'left'), false);
  assert.ok(steer(s, 'a', 'up'));
  assert.ok(steer(s, 'a', 'left'));
  tick(s); tick(s);
  assert.equal(a.dir, 'left');
  assert.equal(b.dir, 'right');
});

test('eating grows the dog that ate', () => {
  const s = newWorld();
  const a = place(addDog(s, { id: 'a', name: 'A' }), [[5, 5], [4, 5], [3, 5]], 'right');
  s.food = [[6, 5]];
  const ev = tick(s);
  assert.ok(ev.some((e) => e.t === 'eat' && e.id === 'a'));
  assert.equal(a.score, 1);
  assert.equal(a.snake.length, 4);
});

test('running into another dog kills you, credits them, and drops bones', () => {
  const s = newWorld();
  const a = place(addDog(s, { id: 'a', name: 'A' }), [[5, 5], [4, 5], [3, 5], [2, 5]], 'right');
  const b = place(addDog(s, { id: 'b', name: 'B' }), [[4, 7], [4, 8], [4, 9]], 'up');
  s.food = [];
  b.queue = [];
  steer(s, 'b', 'up');
  tick(s); // b head -> [4,6]
  const ev = tick(s); // b head -> [4,5], which is a's body
  assert.equal(b.alive, false);
  assert.equal(a.alive, true);
  assert.deepEqual(b.death, { cause: 'dog', by: 'A' });
  assert.ok(ev.some((e) => e.t === 'die' && e.id === 'b'));
  assert.ok(s.food.length >= 2);
});

test('head-on collisions take out both dogs, then they respawn', () => {
  const s = newWorld();
  const a = place(addDog(s, { id: 'a', name: 'A' }), [[5, 5], [4, 5], [3, 5]], 'right');
  const b = place(addDog(s, { id: 'b', name: 'B' }), [[7, 5], [8, 5], [9, 5]], 'left');
  s.food = [];
  tick(s);
  assert.equal(a.alive || b.alive, false);
  assert.equal(a.death.cause, 'headbutt');
  for (let i = 0; i < RESPAWN_TICKS; i++) tick(s);
  assert.ok(a.alive && b.alive);
  assert.equal(a.score, 0);
});

test('chasing your own tail is legal; walls are not', () => {
  const s = newWorld();
  const a = place(addDog(s, { id: 'a', name: 'A' }), [[5, 5], [5, 6], [4, 6], [4, 5]], 'up');
  s.food = [];
  steer(s, 'a', 'left');
  tick(s);
  assert.equal(a.alive, true);
  place(a, [[0, 0], [1, 0]], 'left');
  tick(s);
  assert.equal(a.death.cause, 'wall');
});

test('autopilot pack survives for a long time', () => {
  const rnd = seeded(3);
  const s = newWorld(rnd);
  ['a', 'b', 'c'].forEach((id) => addDog(s, { id, name: id }, rnd));
  let deaths = 0, eats = 0;
  for (let i = 0; i < 600; i++) for (const e of tick(s, rnd)) { if (e.t === 'die') deaths++; if (e.t === 'eat') eats++; }
  assert.ok(eats >= 40, `eats ${eats}`);
  assert.ok(deaths <= 6, `deaths ${deaths}`);
});

test('sanitize round-trips wire state and rejects junk', () => {
  const s = newWorld();
  addDog(s, { id: 'a', name: 'A' });
  tick(s);
  const out = sanitize(JSON.parse(JSON.stringify(wire(s))));
  assert.equal(out.dogs[0].id, 'a');
  assert.deepEqual(out.dogs[0].queue, []);
  assert.equal(sanitize(null), null);
  assert.equal(sanitize({ dogs: 'x', food: [] }), null);
  assert.equal(sanitize({ dogs: [{ id: 'a', dir: 'up', snake: [[999, 1], [1, 1]], alive: true }], food: [] }), null);
  const evil = sanitize({ dogs: [{ id: 'a', dir: 'up', snake: [[1, 1], [1, 2]], alive: true, name: '<img onerror=x>', c: 99, hax: 1 }], food: [] });
  assert.equal(evil.dogs[0].name.includes('<'), false);
  assert.equal(evil.dogs[0].c, 0);
  assert.equal(evil.dogs[0].hax, undefined);
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

test('hall of fame keeps one best score per player', () => {
  let f = [];
  for (const [name, score] of [['a', 3], ['b', 9], ['a', 5], ['c', 0], ['a', 4]]) f = addToFame(f, { name, score, at: score }, 5);
  assert.deepEqual(f.map((e) => `${e.name}${e.score}`), ['b9', 'a5']);
});
