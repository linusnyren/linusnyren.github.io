// Pure game logic for Dachshund Snake "pack mode": every player owns a dog.
// The elected host runs `tick`; every other client only renders the state it
// receives. Shared by browser + tests.

export const COLS = 30, ROWS = 20;
export const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
export const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
export const MAX_QUEUE = 3, MAX_DOGS = 16, MAX_FOOD = 48, TICK_MS = 135, RESPAWN_TICKS = 22;
// Coat colours. Index is what travels over the wire.
export const COATS = ['#b5651d', '#ff2bd6', '#00d8f0', '#5dff9e', '#9d6bff', '#ff7a3d', '#ffe259', '#ff2a6d', '#4d7cff', '#e6f0ff', '#2fd3a0', '#6b3a1e'];
export const BOT_ID = 'cpu';

const k = (x, y) => y * COLS + x;
const inside = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;

export function newWorld(rnd = Math.random) {
  return { w: Math.floor(rnd() * 1e9).toString(36), seq: 0, dogs: [], food: [], events: [] };
}

function occupied(state) {
  const s = new Set();
  for (const d of state.dogs) if (d.alive) for (const [x, y] of d.snake) s.add(k(x, y));
  for (const [x, y] of state.food) s.add(k(x, y));
  return s;
}

export function randomFree(state, rnd = Math.random) {
  const taken = occupied(state);
  const free = [];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (!taken.has(k(x, y))) free.push([x, y]);
  return free.length ? free[Math.floor(rnd() * free.length)] : null;
}

// Find a spot with a clear 3-cell body and 4 cells of runway ahead.
function spawnSpot(state, rnd) {
  const taken = occupied(state);
  for (let tries = 0; tries < 200; tries++) {
    const x = 3 + Math.floor(rnd() * (COLS - 6)), y = 2 + Math.floor(rnd() * (ROWS - 4));
    const dir = x < COLS / 2 ? 'right' : 'left';
    const [dx] = DIRS[dir];
    const cells = [-2, -1, 0, 1, 2, 3, 4].map((i) => [x + dx * i, y]);
    if (cells.every(([cx, cy]) => inside(cx, cy) && !taken.has(k(cx, cy)))) {
      return { snake: [[x, y], [x - dx, y], [x - 2 * dx, y]], dir };
    }
  }
  return null;
}

export function pickCoat(state, id) {
  const used = new Set(state.dogs.map((d) => d.c));
  const free = COATS.map((_, i) => i).filter((i) => !used.has(i));
  if (free.length) return free[0];
  let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % COATS.length;
}

export function addDog(state, { id, name, g = false, bot = false }, rnd = Math.random) {
  if (state.dogs.some((d) => d.id === id) || state.dogs.length >= MAX_DOGS) return null;
  const dog = { id, name, c: pickCoat(state, id), g, bot, snake: [], dir: 'right', queue: [], score: 0, alive: false, respawn: 0, auto: true, death: null };
  state.dogs.push(dog);
  respawn(state, dog, rnd);
  return dog;
}

export function removeDog(state, id) {
  state.dogs = state.dogs.filter((d) => d.id !== id);
}

function respawn(state, dog, rnd) {
  const spot = spawnSpot(state, rnd);
  if (!spot) return false;
  Object.assign(dog, spot, { alive: true, respawn: 0, score: 0, queue: [], death: null });
  state.events.push({ t: 'spawn', id: dog.id });
  return true;
}

// Queue a turn for one dog. Validated against its last queued direction so
// fast double taps (e.g. up then left) both register.
export function steer(state, id, dir) {
  const dog = state.dogs.find((d) => d.id === id);
  if (!dog || !dog.alive || !DIRS[dir]) return false;
  dog.auto = false;
  const last = dog.queue.length ? dog.queue[dog.queue.length - 1] : dog.dir;
  if (dir === last || dir === OPP[last] || dog.queue.length >= MAX_QUEUE) return false;
  dog.queue.push(dir);
  return true;
}

// Autopilot brain: the safe turn with the most room, then the closest bone.
export function autopilot(state, dog) {
  const [hx, hy] = dog.snake[0];
  const blocked = new Set();
  for (const d of state.dogs) if (d.alive) (d === dog ? d.snake.slice(0, -1) : d.snake).forEach(([x, y]) => blocked.add(k(x, y)));
  // keep clear of other dogs' next head positions
  for (const d of state.dogs) if (d.alive && d !== dog) for (const [dx, dy] of Object.values(DIRS)) blocked.add(k(d.snake[0][0] + dx, d.snake[0][1] + dy));
  const free = (x, y) => inside(x, y) && !blocked.has(k(x, y));
  const cap = dog.snake.length * 2 + 6;
  const room = (sx, sy) => {
    const seen = new Set([k(sx, sy)]); const stack = [[sx, sy]];
    while (stack.length && seen.size < cap) {
      const [x, y] = stack.pop();
      for (const [dx, dy] of Object.values(DIRS)) {
        const nx = x + dx, ny = y + dy;
        if (free(nx, ny) && !seen.has(k(nx, ny))) { seen.add(k(nx, ny)); stack.push([nx, ny]); }
      }
    }
    return seen.size;
  };
  let best = null;
  for (const [dir, [dx, dy]] of Object.entries(DIRS)) {
    if (dir === OPP[dog.dir]) continue;
    const nx = hx + dx, ny = hy + dy;
    if (!free(nx, ny)) continue;
    const dist = state.food.length ? Math.min(...state.food.map(([fx, fy]) => Math.abs(fx - nx) + Math.abs(fy - ny))) : 0;
    const score = Math.min(room(nx, ny), cap) * 1000 - dist * 2 + (dir === dog.dir ? 1 : 0);
    if (!best || score > best.score) best = { dir, score };
  }
  return best?.dir ?? dog.dir;
}

// Advance one step for every dog. Fills state.events with what happened.
export function tick(state, rnd = Math.random) {
  state.seq += 1;
  state.events = [];
  const alive = state.dogs.filter((d) => d.alive);
  for (const d of alive) {
    if (d.queue.length) d.dir = d.queue.shift();
    else if (d.auto) d.dir = autopilot(state, d);
  }
  const foodAt = new Map(state.food.map((f, i) => [k(...f), i]));
  const next = new Map(alive.map((d) => {
    const [dx, dy] = DIRS[d.dir];
    const head = [d.snake[0][0] + dx, d.snake[0][1] + dy];
    return [d, { head, eats: foodAt.has(k(...head)) }];
  }));
  // cells occupied after everyone moves (tails vacate unless the dog grows)
  const owner = new Map();
  for (const d of alive) (next.get(d).eats ? d.snake : d.snake.slice(0, -1)).forEach(([x, y]) => owner.set(k(x, y), d));
  const heads = new Map();
  for (const d of alive) { const h = k(...next.get(d).head); heads.set(h, [...(heads.get(h) || []), d]); }

  const dead = [];
  for (const d of alive) {
    const { head } = next.get(d);
    const hk = k(...head);
    let cause = null, by = null;
    if (!inside(...head)) cause = 'wall';
    else if (owner.has(hk)) { const o = owner.get(hk); cause = o === d ? 'self' : 'dog'; by = o === d ? null : o.name; }
    else if (heads.get(hk).length > 1) { cause = 'headbutt'; by = heads.get(hk).find((o) => o !== d).name; }
    if (cause) dead.push([d, cause, by]);
  }
  for (const [d, cause, by] of dead) {
    d.alive = false; d.respawn = RESPAWN_TICKS; d.queue = [];
    d.death = { cause, by };
    state.events.push({ t: 'die', id: d.id, cause, by, score: d.score, at: d.snake[0] });
    // the fallen dog turns into a trail of bones
    d.snake.forEach((p, i) => { if (i % 2 === 0 && state.food.length < MAX_FOOD) state.food.push([p[0], p[1]]); });
  }
  const eaten = new Set();
  for (const d of alive) {
    if (!d.alive) continue;
    const { head, eats } = next.get(d);
    d.snake = [head, ...(eats ? d.snake : d.snake.slice(0, -1))];
    if (eats) { d.score += 1; eaten.add(k(...head)); state.events.push({ t: 'eat', id: d.id, at: head }); }
  }
  // dedupe (corpse bones may overlap) and drop eaten bones
  const seen = new Set();
  state.food = state.food.filter(([x, y]) => { const fk = k(x, y); if (eaten.has(fk) || seen.has(fk)) return false; seen.add(fk); return true; });
  for (const d of state.dogs) if (!d.alive && --d.respawn <= 0) respawn(state, d, rnd);
  const want = Math.min(8, 2 + state.dogs.length);
  while (state.food.length < want) { const f = randomFree(state, rnd); if (!f) break; state.food.push(f); }
  return state.events;
}

// Never trust the network: rebuild a safe state object or return null.
export function sanitize(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.dogs) || !Array.isArray(s.food) || s.dogs.length > MAX_DOGS) return null;
  const pt = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isInteger) && p[0] >= -1 && p[0] <= COLS && p[1] >= -1 && p[1] <= ROWS;
  const str = (v, n = 16) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').slice(0, n) : null);
  const int = (v, min = 0, max = 1e9) => (Number.isInteger(v) && v >= min && v <= max ? v : min);
  const dogs = [];
  for (const d of s.dogs) {
    if (!d || typeof d.id !== 'string' || d.id.length > 12 || !DIRS[d.dir]) return null;
    if (!Array.isArray(d.snake) || d.snake.length > COLS * ROWS || !d.snake.every(pt)) return null;
    if (d.alive && d.snake.length < 2) return null;
    dogs.push({
      id: d.id, name: str(d.name) || '???', c: int(d.c, 0, COATS.length - 1), g: d.g === true, bot: d.bot === true,
      snake: d.snake.map(([x, y]) => [x, y]), dir: d.dir, queue: [], score: int(d.score), alive: d.alive === true,
      respawn: int(d.respawn, 0, 1000), auto: d.auto === true,
      death: d.death && typeof d.death === 'object' ? { cause: str(d.death.cause, 8), by: str(d.death.by) } : null,
    });
  }
  if (!s.food.every(pt) || s.food.length > MAX_FOOD) return null;
  const events = (Array.isArray(s.events) ? s.events : []).slice(0, 64)
    .filter((e) => e && ['eat', 'die', 'spawn'].includes(e.t) && typeof e.id === 'string')
    .map((e) => ({ t: e.t, id: e.id.slice(0, 12), cause: str(e.cause, 8), by: str(e.by), score: int(e.score), at: pt(e.at) ? [e.at[0], e.at[1]] : null }));
  return { w: str(s.w, 12) || '?', seq: int(s.seq), dogs, food: s.food.map(([x, y]) => [x, y]), events };
}

// What the host sends: everything except private input queues.
export const wire = (state) => ({ ...state, dogs: state.dogs.map(({ queue, ...d }) => d) });

// Deterministic host election: oldest active peer wins, id breaks ties.
export function electHost(peers, now, staleMs = 6000) {
  const live = [...peers.values()].filter((p) => now - p.seen < staleMs);
  const pool = live.some((p) => p.active) ? live.filter((p) => p.active) : live;
  pool.sort((a, b) => a.joined - b.joined || (a.id < b.id ? -1 : 1));
  return pool[0]?.id ?? null;
}

// Top scores, one entry per player name.
export function addToFame(fame, entry, size = 10) {
  const best = new Map();
  for (const e of [...(Array.isArray(fame) ? fame : []), entry]) {
    if (!e || !Number.isInteger(e.score) || e.score <= 0 || typeof e.name !== 'string') continue;
    const cur = best.get(e.name);
    if (!cur || e.score > cur.score) best.set(e.name, e);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.at - b.at).slice(0, size);
}
