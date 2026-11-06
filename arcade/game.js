import mqtt from './vendor/mqtt.esm.js';
import { COLS, ROWS, OPP, COATS, BOT_ID, TICK_MS, RESPAWN_TICKS, newWorld, addDog, removeDog, steer, tick, sanitize, wire, electHost, addToFame } from './engine.js';

// ---------- config ----------
const BROKER = 'wss://broker.hivemq.com:8884/mqtt';
const P = 'linusnyren/dachshund-snake/v2';
const T = { presence: `${P}/presence`, bye: `${P}/bye`, state: `${P}/state`, input: `${P}/input`, emote: `${P}/emote`, fame: `${P}/fame` };
const HEARTBEAT_MS = 2000, SETTLE_MS = 2500;
const EMOTES = ['🐶', '🦴', '🔥', '💀', '😂'];
const CELL = 32, S = CELL / 40;

// ---------- identity ----------
const ADJ = ['Turbo', 'Sir', 'Captain', 'Neon', 'Lil', 'Mega', 'Sneaky', 'Hyper', 'Cosmic', 'Wiggly', 'Pixel', 'Retro'];
const NOUN = ['Wiener', 'Sausage', 'Bork', 'Doggo', 'Pupper', 'Snoot', 'Bean', 'Noodle', 'Zoomie', 'Beans', 'Woofer'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
const me = {
  id: Math.random().toString(36).slice(2, 10),
  name: cleanName(localStorage.getItem('dsnake-name')) || `${pick(ADJ)}${pick(NOUN)}${Math.floor(Math.random() * 90 + 10)}`,
  joined: Date.now(),
};
localStorage.setItem('dsnake-name', me.name);

// ---------- dom ----------
const $ = (id) => document.getElementById(id);
const canvas = $('c'), ctx = canvas.getContext('2d');
const ui = { pack: $('pack'), score: $('score'), hi: $('hi'), rank: $('rank'), online: $('online'), players: $('players'), fame: $('fame'), feed: $('feed'), banner: $('banner'), status: $('status'), stage: $('stage'), emotes: $('emotes') };
const li = (text, cls) => { const el = document.createElement('li'); if (cls) el.className = cls; el.textContent = text; return el; };
const swatchRow = (coat, text, right, cls) => {
  const el = document.createElement('li'); if (cls) el.className = cls;
  const l = document.createElement('span'), dot = document.createElement('i'), r = document.createElement('span');
  dot.className = 'dot'; dot.style.background = coat; dot.style.boxShadow = `0 0 8px ${coat}`;
  l.append(dot, text); r.textContent = right; el.append(l, r);
  return el;
};

// ---------- shared state ----------
const peers = new Map();
let client, connected = false, settled = false, hostId = null, amHost = false;
let state = null, view = null, fame = [], hiLocal = 0;
let hostTimer = null;
let golden = localStorage.getItem('dsnake-golden') === '1';
const lastInput = new Map();
const myDog = () => view?.cur.dogs.find((d) => d.id === me.id);

// ---------- network ----------
function publish(topic, obj, opts = {}) {
  if (connected) client.publish(topic, JSON.stringify(obj), { qos: 0, ...opts });
}

function heartbeat() {
  const p = { id: me.id, name: me.name, joined: me.joined, active: !document.hidden, golden };
  peers.set(me.id, { ...p, seen: Date.now() });
  publish(`${T.presence}/${me.id}`, p);
}

function connect() {
  client = mqtt.connect(BROKER, {
    clientId: `dsnake_${me.id}`, clean: true, keepalive: 20, reconnectPeriod: 2000, connectTimeout: 8000,
    will: { topic: `${T.bye}/${me.id}`, payload: me.id, qos: 0, retain: false },
  });
  client.on('connect', () => {
    connected = true;
    setStatus('● connected to the grid', 'ok');
    client.subscribe([`${T.presence}/+`, `${T.bye}/+`, T.state, T.input, T.emote, T.fame]);
    heartbeat();
    setTimeout(() => { settled = true; elect(); }, SETTLE_MS);
  });
  client.on('reconnect', () => setStatus('● reconnecting…', 'bad'));
  client.on('offline', () => { connected = false; setStatus('● offline', 'bad'); });
  client.on('error', (e) => setStatus(`● ${e.message}`, 'bad'));
  client.on('message', onMessage);
}

function onMessage(topic, buf) {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  const now = Date.now();

  if (topic.startsWith(`${T.presence}/`)) {
    if (typeof msg.id !== 'string' || msg.id.length > 12 || msg.id === BOT_ID || !Number.isFinite(msg.joined)) return;
    peers.set(msg.id, { id: msg.id, name: cleanName(msg.name) || '???', joined: msg.joined, active: !!msg.active, golden: !!msg.golden, seen: now });
    return;
  }
  if (topic.startsWith(`${T.bye}/`)) { peers.delete(topic.split('/').pop()); elect(); return; }

  if (topic === T.state) {
    if (amHost && msg.from !== me.id) {
      // Someone else is hosting too. Defer to them if the election agrees.
      if (electHost(peers, now) !== me.id) stepDown();
      else return;
    }
    if (amHost) return;
    if (hostId && msg.from && msg.from !== hostId && peers.has(hostId)) return;
    receive(sanitize(msg));
    return;
  }

  if (topic === T.input) {
    if (!OPP[msg.dir] || typeof msg.id !== 'string' || msg.id === BOT_ID) return;
    const t = lastInput.get(msg.id) || 0; // crude per-player flood limit
    if (now - t < 40) return;
    lastInput.set(msg.id, now);
    if (amHost && msg.id !== me.id) steer(state, msg.id, msg.dir);
    return;
  }

  if (topic === T.emote) {
    if (!EMOTES.includes(msg.e)) return;
    floatEmote(msg.e, cleanName(msg.name), typeof msg.id === 'string' ? msg.id : null);
    return;
  }

  if (topic === T.fame && Array.isArray(msg.list)) {
    fame = msg.list.slice(0, 10).map((e) => ({ name: cleanName(e?.name), c: Number.isInteger(e?.c) && COATS[e.c] ? e.c : 0, score: Number.isInteger(e?.score) ? e.score : 0, at: Number(e?.at) || 0 })).filter((e) => e.score > 0 && e.name);
    renderFame();
  }
}

// ---------- host election + host loop ----------
function elect() {
  const now = Date.now();
  for (const [id, p] of peers) if (id !== me.id && now - p.seen > 6000) peers.delete(id);
  if (!settled || !connected) return;
  hostId = electHost(peers, now);
  if (hostId === me.id && !amHost) becomeHost();
  else if (hostId !== me.id && amHost) stepDown();
  renderPlayers();
}

function becomeHost() {
  amHost = true;
  state = (view && sanitize(JSON.parse(JSON.stringify(view.cur)))) || newWorld();
  banner('👑 YOU ARE THE HOST — your browser runs the pack', 3500);
  loop();
}

function stepDown() {
  amHost = false;
  clearTimeout(hostTimer);
}

// Make the pack match who is online: one dog per player, plus a CPU dog when lonely.
function syncPack() {
  const now = Date.now();
  const live = [...peers.values()].filter((p) => now - p.seen < 6000).sort((a, b) => a.joined - b.joined);
  const ids = new Set(live.map((p) => p.id));
  for (const d of [...state.dogs]) if (!d.bot && !ids.has(d.id)) removeDog(state, d.id);
  for (const p of live) {
    const d = state.dogs.find((x) => x.id === p.id) || addDog(state, { id: p.id, name: p.name, g: p.golden });
    if (!d) continue;
    d.name = p.name; d.g = p.golden;
    if (!p.active) d.auto = true; // hidden tabs get an autopilot babysitter
  }
  const bot = state.dogs.find((d) => d.bot);
  if (live.length < 2 && !bot) addDog(state, { id: BOT_ID, name: 'CPU-9000', bot: true });
  if (live.length >= 2 && bot) removeDog(state, BOT_ID);
}

function loop() {
  clearTimeout(hostTimer);
  if (!amHost) return;
  syncPack();
  const events = tick(state);
  let fameChanged = false;
  for (const e of events) {
    const d = state.dogs.find((x) => x.id === e.id);
    if (e.t === 'die' && d && !d.bot && e.score > 0) {
      const next = addToFame(fame, { name: d.name, c: d.c, score: e.score, at: Date.now() });
      if (JSON.stringify(next) !== JSON.stringify(fame)) { fame = next; fameChanged = true; }
    }
  }
  if (fameChanged) { publish(T.fame, { list: fame }, { retain: true }); renderFame(); }
  const out = wire(state);
  publish(T.state, { ...out, from: me.id }, { retain: true });
  receive(sanitize(JSON.parse(JSON.stringify(out))));
  hostTimer = setTimeout(loop, TICK_MS);
}

// ---------- local input ----------
function sendDir(dir) {
  audio.unlock();
  publish(T.input, { id: me.id, dir });
  if (amHost) steer(state, me.id, dir);
  const b = document.querySelector(`.pad button[data-dir=${dir}]`);
  b?.classList.add('hit'); setTimeout(() => b?.classList.remove('hit'), 90);
}
let lastEmote = 0;
function sendEmote(e) {
  if (Date.now() - lastEmote < 350) return;
  lastEmote = Date.now();
  publish(T.emote, { e, name: me.name, id: me.id });
}

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let kIdx = 0;
const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  kIdx = k === KONAMI[kIdx] ? kIdx + 1 : (k === KONAMI[0] ? 1 : 0);
  if (kIdx === KONAMI.length) {
    kIdx = 0; golden = !golden; localStorage.setItem('dsnake-golden', golden ? '1' : '0');
    banner(golden ? '🌟 KONAMI! GOLDEN DOGGO UNLOCKED 🌟' : 'golden doggo off', 3000); audio.win(); heartbeat();
  }
  if (KEYS[k]) { e.preventDefault(); sendDir(KEYS[k]); }
  const n = Number(e.key);
  if (n >= 1 && n <= EMOTES.length) sendEmote(EMOTES[n - 1]);
});
document.querySelectorAll('[data-dir]').forEach((b) => b.addEventListener('pointerdown', (e) => { e.preventDefault(); sendDir(b.dataset.dir); }));
document.querySelectorAll('[data-emote]').forEach((b) => b.addEventListener('click', () => sendEmote(b.dataset.emote)));
let touch = null;
canvas.addEventListener('pointerdown', (e) => { touch = [e.clientX, e.clientY]; canvas.focus(); });
canvas.addEventListener('pointerup', (e) => {
  if (!touch) return;
  const dx = e.clientX - touch[0], dy = e.clientY - touch[1];
  touch = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
  sendDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
});
$('nameBtn').addEventListener('click', () => {
  const n = cleanName(prompt('Pick a player name (max 16 chars):', me.name));
  if (n) { me.name = n; localStorage.setItem('dsnake-name', n); heartbeat(); renderPlayers(); }
});
$('soundBtn').addEventListener('click', (e) => { audio.on = !audio.on; audio.unlock(); e.currentTarget.textContent = audio.on ? '🔊 SOUND' : '🔇 SOUND'; });
document.addEventListener('visibilitychange', () => { heartbeat(); elect(); });

// ---------- audio ----------
const audio = {
  on: false, ac: null,
  unlock() { if (!this.ac) try { this.ac = new AudioContext(); } catch {} },
  beep(freqs, dur = 0.08, type = 'square', vol = 0.06) {
    if (!this.on || !this.ac) return;
    const t0 = this.ac.currentTime;
    freqs.forEach((f, i) => {
      const o = this.ac.createOscillator(), g = this.ac.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(vol, t0 + i * dur); g.gain.exponentialRampToValueAtTime(0.0001, t0 + (i + 1) * dur);
      o.connect(g).connect(this.ac.destination); o.start(t0 + i * dur); o.stop(t0 + (i + 1) * dur);
    });
  },
  eat() { this.beep([660, 990, 1320], 0.06); },
  die() { this.beep([440, 330, 220, 110], 0.14, 'sawtooth', 0.08); },
  win() { this.beep([523, 659, 784, 1046, 1318], 0.08); },
};

// ---------- view model (interpolation, particles, fx) ----------
const particles = [];
let shakeT = 0, flashT = 0, lastPanel = 0;
const CAUSE = { wall: () => 'hit a wall', self: () => 'bit its own tail', dog: (by) => `crashed into ${by || 'a dog'}`, headbutt: (by) => `headbutted ${by || 'a dog'}` };
const coatOf = (d) => COATS[d.c] || COATS[0];

function burst([x, y], color, n = 22, power = 9) {
  for (let i = 0; i < n; i++) particles.push({ x: x * CELL + CELL / 2, y: y * CELL + CELL / 2, vx: (Math.random() - 0.5) * power, vy: (Math.random() - 0.5) * power - 2, life: 1, c: Math.random() < 0.5 ? color : pick(['#ffe259', '#fff8e7']) });
}

function receive(s) {
  if (!s) return;
  const sameWorld = view && view.cur.w === s.w;
  if (sameWorld && s.seq <= view.cur.seq) return;
  const prev = new Map();
  if (sameWorld && s.seq === view.cur.seq + 1) for (const d of view.cur.dogs) if (d.alive) prev.set(d.id, d.snake);
  const before = new Map((view?.cur.dogs || []).map((d) => [d.id, d]));
  const firstView = !view;
  view = { prev, cur: s, at: performance.now() };
  if (!amHost) state = s;

  if (!firstView) {
    for (const d of s.dogs) if (!before.has(d.id)) feedRow(coatOf(d), `${d.name} joined the pack`, d.bot ? '🤖' : '🐶', d.id === me.id);
    for (const [id, d] of before) if (!s.dogs.some((x) => x.id === id)) feedRow(coatOf(d), `${d.name} left`, '👋');
  }
  for (const e of s.events) {
    const d = s.dogs.find((x) => x.id === e.id);
    if (!d) continue;
    const mine = d.id === me.id;
    if (e.t === 'eat' && e.at) {
      burst(e.at, coatOf(d), mine ? 26 : 12, mine ? 9 : 6);
      if (mine) { audio.eat(); particles.push({ x: e.at[0] * CELL + CELL / 2, y: e.at[1] * CELL, vx: 0, vy: -1.2, life: 1.6, text: '+1' }); }
    }
    if (e.t === 'die') {
      if (e.at) burst(e.at, coatOf(d), 40, 12);
      feedRow(coatOf(d), `${d.name} ${(CAUSE[e.cause] || CAUSE.wall)(e.by)}${e.score ? ` · ${e.score} 🦴` : ''}`, '💀', mine);
      if (mine) {
        audio.die(); shakeT = 1; flashT = 1;
        ui.stage.classList.remove('shake'); void ui.stage.offsetWidth; ui.stage.classList.add('shake');
      } else if (e.by === me.name) { audio.beep([880, 1320], 0.07); banner(`💥 YOU TOOK OUT ${d.name.toUpperCase()}`, 1600); }
    }
    if (e.t === 'spawn' && mine && !firstView && before.has(me.id)) banner('🐶 BACK IN THE PACK', 1200);
  }
  const mineNow = s.dogs.find((d) => d.id === me.id);
  const ranked = [...s.dogs].sort((a, b) => b.score - a.score);
  hiLocal = Math.max(hiLocal, mineNow?.score || 0, fame[0]?.score || 0);
  ui.pack.textContent = s.dogs.length;
  ui.score.textContent = String(mineNow?.score || 0).padStart(3, '0');
  ui.hi.textContent = String(hiLocal).padStart(3, '0');
  ui.rank.textContent = mineNow ? `#${ranked.indexOf(mineNow) + 1}` : '–';
  if (s.events.length || s.seq - lastPanel >= 4 || s.seq < lastPanel) { lastPanel = s.seq; renderPlayers(); }
}

// ---------- rendering ----------
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function drawBoard(t) {
  ctx.fillStyle = '#0b0418';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if ((x + y) % 2) { ctx.fillStyle = 'rgba(255,255,255,0.025)'; ctx.fillRect(x * CELL, y * CELL, CELL, CELL); }
  }
  ctx.strokeStyle = 'rgba(255,43,214,0.13)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= COLS; x++) { ctx.moveTo(x * CELL + 0.5, 0); ctx.lineTo(x * CELL + 0.5, ROWS * CELL); }
  for (let y = 0; y <= ROWS; y++) { ctx.moveTo(0, y * CELL + 0.5); ctx.lineTo(COLS * CELL, y * CELL + 0.5); }
  ctx.stroke();
  const sx = ((t / 4000) % 1) * canvas.width;
  const g = ctx.createLinearGradient(sx - 120, 0, sx, 0);
  g.addColorStop(0, 'rgba(0,240,255,0)'); g.addColorStop(1, 'rgba(0,240,255,0.08)');
  ctx.fillStyle = g; ctx.fillRect(sx - 120, 0, 120, canvas.height);
}

function drawBone([x, y], t, i) {
  const cx = x * CELL + CELL / 2, cy = y * CELL + CELL / 2 + Math.sin(t / 220 + i) * 2.5;
  const pulse = (t / 1400 + i * 0.37) % 1;
  ctx.beginPath(); ctx.arc(cx, cy, 8 + pulse * 14, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255,226,89,${0.5 * (1 - pulse)})`; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.5 + Math.sin(t / 400 + i) * 0.15); ctx.scale(S, S);
  ctx.shadowColor = '#ffe259'; ctx.shadowBlur = 16; ctx.fillStyle = '#fff8e7';
  ctx.fillRect(-10, -4, 20, 8);
  for (const [bx, by] of [[-11, -4.5], [-11, 4.5], [11, -4.5], [11, 4.5]]) { ctx.beginPath(); ctx.arc(bx, by, 5.2, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

function dogPoints(dog, t) {
  const k = Math.min(1, (t - view.at) / TICK_MS);
  const e = dog.alive ? ease(k) : 1;
  const prev = view.prev.get(dog.id) || dog.snake;
  return dog.snake.map((p, i) => {
    const q = prev[i] ?? prev[prev.length - 1] ?? p;
    return [lerp(q[0], p[0], e) * CELL + CELL / 2, lerp(q[1], p[1], e) * CELL + CELL / 2];
  });
}

function drawDog(dog, pts, t) {
  const n = pts.length;
  if (n < 2) return;
  const dead = !dog.alive, mine = dog.id === me.id, coat = coatOf(dog);
  const dark = shade(coat, -0.55), headC = shade(coat, 0.12), snout = shade(coat, 0.3);
  const body = dog.g ? (() => { const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height); ['#ff2a6d', '#ffe259', '#5dff9e', '#00f0ff', '#ff2bd6'].forEach((c, i) => g.addColorStop(i / 4, c)); return g; })() : coat;
  ctx.save();
  if (dead) ctx.globalAlpha = Math.max(0, (dog.respawn - (RESPAWN_TICKS - 10)) / 10) * 0.6;
  // "you are here" ring
  if (mine && !dead) {
    const r = 26 + Math.sin(t / 160) * 4;
    ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], r, 0, Math.PI * 2);
    ctx.strokeStyle = coat; ctx.globalAlpha = 0.45; ctx.lineWidth = 2; ctx.setLineDash([5, 6]); ctx.lineDashOffset = -t / 30; ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  // tail
  const [tx, ty] = pts[n - 1], [px, py] = pts[n - 2];
  const ta = Math.atan2(ty - py, tx - px), wag = dead ? 0 : Math.sin(t / 70) * 0.6;
  ctx.save(); ctx.translate(tx, ty); ctx.rotate(ta + wag); ctx.scale(S, S);
  ctx.strokeStyle = dark; ctx.lineWidth = 6; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(6, 0); ctx.quadraticCurveTo(20, -4, 26, -14); ctx.stroke(); ctx.restore();
  // paws
  const legs = [1, n - 2].filter((i, j, a) => i > 0 && a.indexOf(i) === j);
  legs.forEach((i, j) => {
    const [x, y] = pts[i], [nx, ny] = pts[i - 1];
    const a = Math.atan2(ny - y, nx - x), step = dead ? 0 : Math.sin(t / 60 + j * Math.PI) * 4;
    for (const side of [1, -1]) {
      ctx.fillStyle = dark; ctx.beginPath();
      ctx.ellipse(x - Math.sin(a) * 14 * side + Math.cos(a) * step * side, y + Math.cos(a) * 14 * side + Math.sin(a) * step * side, 5, 4, a, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  // body
  const path = () => { ctx.beginPath(); ctx.moveTo(...pts[0]); for (let i = 1; i < n; i++) ctx.lineTo(...pts[i]); };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.shadowColor = dog.g ? '#ffe259' : coat; ctx.shadowBlur = mine ? 22 : 12;
  path(); ctx.strokeStyle = dark; ctx.lineWidth = 26; ctx.stroke();
  ctx.shadowColor = 'transparent';
  path(); ctx.strokeStyle = body; ctx.lineWidth = 21; ctx.stroke();
  ctx.save(); ctx.translate(-1.5, -3); path(); ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 6; ctx.stroke(); ctx.restore();
  // collar
  const [hx, hy] = pts[0], [nx, ny] = pts[1];
  const ha = Math.atan2(hy - ny, hx - nx);
  ctx.save(); ctx.translate(lerp(hx, nx, 0.42), lerp(hy, ny, 0.42)); ctx.rotate(ha); ctx.scale(S, S);
  ctx.fillStyle = mine ? '#ffe259' : '#00f0ff'; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 12; ctx.fillRect(-3, -15, 6, 30);
  ctx.fillStyle = '#ffe259'; ctx.beginPath(); ctx.arc(2, 15, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  // head (drawn facing +x)
  ctx.save(); ctx.translate(hx, hy); ctx.rotate(ha); ctx.scale(S, S);
  const flop = dead ? 0.6 : Math.sin(t / 110 + dog.c) * 0.35;
  ctx.fillStyle = dark;
  for (const s of [1, -1]) {
    ctx.save(); ctx.translate(-6, 10 * s); ctx.rotate((0.5 + flop) * s);
    ctx.beginPath(); ctx.ellipse(-6, 5 * s, 12, 7, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  ctx.fillStyle = dog.g ? '#ffd23f' : headC; ctx.beginPath(); ctx.ellipse(2, 0, 18, 15, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = dog.g ? '#ffe98a' : snout; ctx.beginPath(); ctx.ellipse(15, 1, 11, 8.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#111'; ctx.beginPath(); ctx.ellipse(25, 0, 4.5, 4, 0, 0, Math.PI * 2); ctx.fill();
  if (dead) {
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5;
    for (const s of [1, -1]) { ctx.beginPath(); ctx.moveTo(3, 6 * s - 3); ctx.lineTo(9, 6 * s + 3); ctx.moveTo(9, 6 * s - 3); ctx.lineTo(3, 6 * s + 3); ctx.stroke(); }
  } else {
    for (const s of [1, -1]) {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(6, 7 * s, 4.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(7.5, 7 * s, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(8.3, 7 * s - 1, 0.9, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.fillStyle = '#ff4f8b';
  const tongue = dead ? 12 : 7 + Math.sin(t / 90) * 3;
  ctx.beginPath(); ctx.ellipse(21, 8, 4, tongue / 2, 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // name tag
  if (!dead) {
    const label = `${dog.g ? '👑 ' : ''}${dog.bot || dog.auto ? '🤖 ' : ''}${mine ? 'YOU' : dog.name}`;
    ctx.font = `700 ${mine ? 13 : 11}px ui-monospace, Menlo, monospace`; ctx.textAlign = 'center';
    const w = ctx.measureText(label).width + 12, bob = mine ? Math.abs(Math.sin(t / 200)) * 4 : 0, ly = hy < 44 ? hy + 36 + bob : hy - 30 - bob;
    ctx.fillStyle = 'rgba(5,1,15,0.75)'; ctx.strokeStyle = coat; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(hx - w / 2, ly - 12, w, 17, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = mine ? '#ffe259' : coat; ctx.fillText(label, hx, ly + 1);
  }
  ctx.restore();
}

function drawParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.vy += p.text ? 0 : 0.25; p.life -= 0.025;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    ctx.globalAlpha = Math.min(1, p.life);
    if (p.text) {
      ctx.font = '900 22px Impact, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffe259';
      ctx.shadowColor = '#ff2bd6'; ctx.shadowBlur = 10; ctx.fillText(p.text, p.x, p.y); ctx.shadowBlur = 0;
    } else { ctx.fillStyle = p.c; ctx.fillRect(p.x - 3, p.y - 3, 6, 6); }
  }
  ctx.globalAlpha = 1;
}

function bigText(text, y, size) {
  ctx.save(); ctx.translate(canvas.width / 2, y);
  const sc = 1 + Math.sin(performance.now() / 200) * 0.04; ctx.scale(sc, sc);
  ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`; ctx.textAlign = 'center';
  ctx.fillStyle = '#00f0ff'; ctx.fillText(text, -4, 0);
  ctx.fillStyle = '#ff2bd6'; ctx.fillText(text, 4, 0);
  ctx.fillStyle = '#fff'; ctx.shadowColor = '#ff2a6d'; ctx.shadowBlur = 30; ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawOverlay(t) {
  const d = myDog();
  ctx.textAlign = 'center';
  if (!d) {
    ctx.font = '700 18px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#00f0ff';
    ctx.fillText('JOINING THE PACK' + '.'.repeat(Math.floor(t / 300) % 4), canvas.width / 2, 40);
    return;
  }
  if (!d.alive) {
    ctx.fillStyle = 'rgba(5,1,15,0.45)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    bigText('BONKED!', canvas.height / 2 - 20, 88);
    ctx.font = '700 20px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#e6f7ff';
    ctx.fillText(`your doggo ${(CAUSE[d.death?.cause] || CAUSE.wall)(d.death?.by)}`, canvas.width / 2, canvas.height / 2 + 30);
    ctx.fillStyle = '#ffe259';
    const secs = Math.max(0, (d.respawn * TICK_MS - (t - view.at)) / 1000);
    ctx.fillText(`RESPAWN IN ${secs.toFixed(1)}`, canvas.width / 2, canvas.height / 2 + 64);
    return;
  }
  if (d.auto) {
    ctx.save();
    ctx.font = 'bold 20px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(0,240,255,0.85)'; ctx.shadowColor = '#00f0ff'; ctx.shadowBlur = 14;
    ctx.fillText('🤖 YOUR DOG IS ON AUTOPILOT', canvas.width / 2, 40);
    if (Math.floor(t / 600) % 2) {
      ctx.font = 'bold 14px ui-monospace, monospace'; ctx.fillStyle = '#ffe259'; ctx.shadowColor = '#ff2bd6';
      ctx.fillText('PRESS ANY ARROW TO TAKE THE LEASH', canvas.width / 2, 64);
    }
    ctx.restore();
  }
}

function drawWaiting(t) {
  drawBoard(t);
  ctx.textAlign = 'center'; ctx.fillStyle = '#00f0ff'; ctx.font = '700 24px ui-monospace, Menlo, monospace';
  ctx.fillText(connected ? 'SYNCING WITH OTHER PLAYERS' + '.'.repeat(Math.floor(t / 300) % 4) : 'CONNECTING TO THE GRID' + '.'.repeat(Math.floor(t / 300) % 4), canvas.width / 2, canvas.height / 2);
}

function frame(t) {
  if (!view) drawWaiting(t);
  else {
    ctx.save();
    if (shakeT > 0) { ctx.translate((Math.random() - 0.5) * 16 * shakeT, (Math.random() - 0.5) * 16 * shakeT); shakeT = Math.max(0, shakeT - 0.04); }
    drawBoard(t);
    view.cur.food.forEach((f, i) => drawBone(f, t, i));
    const dogs = [...view.cur.dogs].sort((a, b) => (a.alive - b.alive) || ((a.id === me.id) - (b.id === me.id)));
    for (const d of dogs) drawDog(d, dogPoints(d, t), t);
    drawParticles();
    ctx.restore();
    if (flashT > 0) { ctx.fillStyle = `rgba(255,42,109,${flashT * 0.5})`; ctx.fillRect(0, 0, canvas.width, canvas.height); flashT = Math.max(0, flashT - 0.05); }
    drawOverlay(t);
  }
  requestAnimationFrame(frame);
}

// ---------- side panels ----------
function renderPlayers() {
  const dogs = [...(view?.cur.dogs || [])].sort((a, b) => b.score - a.score);
  const humans = [...peers.values()].length;
  ui.online.textContent = dogs.length || humans;
  $('dogsWord').textContent = (dogs.length || humans) === 1 ? 'DOG' : 'DOGS';
  const rows = dogs.map((d) => swatchRow(coatOf(d), ` ${d.id === hostId ? '👑 ' : ''}${d.g ? '🌟 ' : ''}${d.bot ? '🤖 ' : ''}${d.name}${d.id === me.id ? ' (you)' : ''}`, d.alive ? `${d.score} 🦴` : '💀', d.id === me.id ? 'me' : ''));
  ui.players.replaceChildren(...(rows.length ? rows : [li('scanning…', 'dim')]));
}
function renderFame() {
  hiLocal = Math.max(hiLocal, fame[0]?.score || 0);
  ui.hi.textContent = String(hiLocal).padStart(3, '0');
  ui.fame.replaceChildren(...(fame.length ? fame.map((e, i) => swatchRow(COATS[e.c] || COATS[0], ` ${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} ${e.name}`, `${e.score} 🦴`)) : [li('no legends yet', 'dim')]));
}
function feedRow(coat, text, icon, mine) {
  if (ui.feed.firstChild?.classList?.contains('dim')) ui.feed.replaceChildren();
  ui.feed.prepend(swatchRow(coat, ` ${icon} ${text}`, '', mine ? 'me' : ''));
  while (ui.feed.children.length > 8) ui.feed.lastChild.remove();
}
function floatEmote(e, name, id) {
  const el = document.createElement('div');
  el.className = 'emote';
  const dog = view?.cur.dogs.find((d) => d.id === id && d.alive);
  if (dog) {
    el.style.left = `${((dog.snake[0][0] + 0.5) / COLS) * 100}%`;
    el.style.top = `${(dog.snake[0][1] / ROWS) * 100}%`;
    el.style.bottom = 'auto'; el.style.marginLeft = '-17px'; el.style.marginTop = '-40px';
  } else el.style.left = `${5 + Math.random() * 85}%`;
  el.textContent = e;
  const s = document.createElement('small'); s.textContent = name; el.append(s);
  ui.emotes.append(el); setTimeout(() => el.remove(), 2700);
  if (ui.emotes.children.length > 40) ui.emotes.firstChild.remove();
}
let bannerTimer;
function banner(text, ms) {
  ui.banner.textContent = text; ui.banner.style.opacity = 1;
  clearTimeout(bannerTimer); if (ms) bannerTimer = setTimeout(() => (ui.banner.style.opacity = 0), ms);
}
function setStatus(text, cls) { ui.status.textContent = text; ui.status.className = `status ${cls}`; }

// ---------- go ----------
setInterval(heartbeat, HEARTBEAT_MS);
setInterval(elect, 700);
connect();
banner('CONNECTING TO THE GRID…');
setTimeout(() => connected && banner(`WELCOME, ${me.name.toUpperCase()} — STEER YOUR DOG WITH ←↑↓→`, 3500), SETTLE_MS);
requestAnimationFrame(frame);
canvas.focus();

// test hook
window.__dsnake = { me, peers, get amHost() { return amHost; }, get hostId() { return hostId; }, get view() { return view; }, myDog, sendDir };
