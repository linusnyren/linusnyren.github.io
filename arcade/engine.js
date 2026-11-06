// Pure game logic for Dachshund Snake. The elected host runs `tick`; every
// other client only renders the state it receives. Shared by browser + tests.

export const COLS = 24, ROWS = 16;
export const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
export const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
export const MAX_QUEUE = 3;

const key = ([x, y]) => x * 100 + y;

export function randomFree(snake, rnd = Math.random) {
  const taken = new Set(snake.map(key));
  const free = [];
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (!taken.has(x * 100 + y)) free.push([x, y]);
  return free.length ? free[Math.floor(rnd() * free.length)] : null;
}

export function newGame(prev, rnd = Math.random) {
  const y = Math.floor(ROWS / 2);
  const snake = [[5, y], [4, y], [3, y]];
  return {
    game: (prev?.game || 0) + 1, seq: 0, snake, dir: 'right', queue: [],
    food: randomFree(snake, rnd), score: 0, status: 'playing', crew: [], death: null, endedAt: 0, auto: true,
  };
}

// Queue a turn. Validated against the last queued direction so fast double
// taps (e.g. up then left) both register within one tick.
export function steer(state, dir, name) {
  if (!DIRS[dir] || state.status !== 'playing') return false;
  const last = state.queue.length ? state.queue[state.queue.length - 1].dir : state.dir;
  if (dir === last || dir === OPP[last] || state.queue.length >= MAX_QUEUE) return false;
  state.queue.push({ dir, name });
  return true;
}

// Advance one step. Returns an event: 'move' | 'eat' | 'die' | 'win' | null.
export function tick(state, rnd = Math.random) {
  if (state.status !== 'playing') return null;
  state.seq += 1;
  const turn = state.queue.shift();
  if (turn) {
    state.dir = turn.dir;
    if (turn.name) state.auto = false;
    if (turn.name && !state.crew.includes(turn.name)) state.crew = [...state.crew, turn.name].slice(-12);
  }
  const [dx, dy] = DIRS[state.dir];
  const head = [state.snake[0][0] + dx, state.snake[0][1] + dy];
  const eating = state.food && head[0] === state.food[0] && head[1] === state.food[1];
  const body = eating ? state.snake : state.snake.slice(0, -1);
  const wall = head[0] < 0 || head[1] < 0 || head[0] >= COLS || head[1] >= ROWS;
  if (wall || body.some((p) => p[0] === head[0] && p[1] === head[1])) {
    state.status = 'over';
    state.death = { cause: wall ? 'wall' : 'self', by: turn?.name || null };
    state.queue = [];
    return 'die';
  }
  state.snake = [head, ...body];
  if (!eating) return 'move';
  state.score += 1;
  state.food = randomFree(state.snake, rnd);
  if (!state.food) { state.status = 'over'; state.death = { cause: 'win' }; return 'win'; }
  return 'eat';
}

// Attract-mode brain: pick the safe turn with the most room, then the one
// closest to the bone. Used by the host while no human is steering.
export function autopilot(state) {
  const [hx, hy] = state.snake[0];
  const body = state.snake.slice(0, -1);
  const key = (x, y) => y * COLS + x;
  const blocked = new Set(body.map(([x, y]) => key(x, y)));
  const free = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS && !blocked.has(key(x, y));
  const room = (sx, sy, cap) => {
    const seen = new Set([key(sx, sy)]); const stack = [[sx, sy]];
    while (stack.length && seen.size < cap) {
      const [x, y] = stack.pop();
      for (const [dx, dy] of Object.values(DIRS)) {
        const nx = x + dx, ny = y + dy;
        if (free(nx, ny) && !seen.has(key(nx, ny))) { seen.add(key(nx, ny)); stack.push([nx, ny]); }
      }
    }
    return seen.size;
  };
  const cap = state.snake.length * 2 + 4;
  let best = null;
  for (const [dir, [dx, dy]] of Object.entries(DIRS)) {
    if (dir === OPP[state.dir]) continue;
    const nx = hx + dx, ny = hy + dy;
    if (!free(nx, ny)) continue;
    const space = Math.min(room(nx, ny, cap), cap);
    const dist = state.food ? Math.abs(state.food[0] - nx) + Math.abs(state.food[1] - ny) : 0;
    const score = space * 1000 - dist * 2 + (dir === state.dir ? 1 : 0);
    if (!best || score > best.score) best = { dir, score };
  }
  return best?.dir ?? state.dir;
}

export const tickMs = (score) => Math.max(95, 210 - score * 5);

// Never trust the network: rebuild a safe state object or return null.
export function sanitize(s) {
  if (!s || typeof s !== 'object') return null;
  const pt = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isInteger) && p[0] >= -1 && p[0] <= COLS && p[1] >= -1 && p[1] <= ROWS;
  if (!Array.isArray(s.snake) || s.snake.length < 2 || s.snake.length > COLS * ROWS || !s.snake.every(pt)) return null;
  if (!DIRS[s.dir] || !['playing', 'over'].includes(s.status)) return null;
  const str = (v, n = 20) => (typeof v === 'string' ? v.slice(0, n) : null);
  return {
    game: Number.isInteger(s.game) ? s.game : 1,
    seq: Number.isInteger(s.seq) ? s.seq : 0,
    snake: s.snake.map(([x, y]) => [x, y]),
    dir: s.dir,
    queue: [],
    food: pt(s.food) ? [s.food[0], s.food[1]] : null,
    score: Number.isInteger(s.score) && s.score >= 0 ? s.score : 0,
    status: s.status,
    crew: Array.isArray(s.crew) ? s.crew.map((c) => str(c)).filter(Boolean).slice(0, 12) : [],
    death: s.death && typeof s.death === 'object' ? { cause: str(s.death.cause, 8), by: str(s.death.by) } : null,
    endedAt: Number.isFinite(s.endedAt) ? s.endedAt : 0,
    auto: s.auto === true,
  };
}

// Deterministic host election: oldest active peer wins, id breaks ties.
export function electHost(peers, now, staleMs = 6000) {
  const live = [...peers.values()].filter((p) => now - p.seen < staleMs);
  const pool = live.some((p) => p.active) ? live.filter((p) => p.active) : live;
  pool.sort((a, b) => a.joined - b.joined || (a.id < b.id ? -1 : 1));
  return pool[0]?.id ?? null;
}

export function addToFame(fame, entry, size = 10) {
  const list = [...(Array.isArray(fame) ? fame : []), entry]
    .filter((e) => e && Number.isInteger(e.score) && e.score > 0)
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, size);
  return list;
}
