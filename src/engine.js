/* Moteur de règles de Brumes.
   Aucune dépendance à l'affichage : l'état est un objet JSON sérialisable,
   et chaque action renvoie la liste des événements à animer. */

export const RES = ['bois', 'pierre', 'lin', 'grain', 'cristal'];
export const RES_INFO = {
  bois:    { nom: 'Bois',    ic: '🪵', terrain: 'Sylve',     col: '#3d7a46' },
  pierre:  { nom: 'Pierre',  ic: '🪨', terrain: 'Carrière',  col: '#c0683c' },
  lin:     { nom: 'Lin',     ic: '🧵', terrain: 'Lande',     col: '#98b957' },
  grain:   { nom: 'Grain',   ic: '🌾', terrain: 'Terrasses', col: '#dfac45' },
  cristal: { nom: 'Cristal', ic: '💎', terrain: 'Pics',      col: '#7c879e' },
};
/* Île standard (2-4 joueurs) : 19 tuiles. Grande île (5-6 joueurs) : 31 tuiles, coins rognés. */
const TERRAIN_COUNTS = { bois: 4, pierre: 3, lin: 4, grain: 4, cristal: 3 };
const TERRAIN_COUNTS_BIG = { bois: 7, pierre: 5, lin: 7, grain: 6, cristal: 5 };
const NUMBERS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
const NUMBERS_BIG = [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12];
export const PIPS = n => 6 - Math.abs(7 - n);
const BASE_COSTS = { sentier: { bois: 1, pierre: 1 }, camp: { bois: 1, pierre: 1, lin: 1, grain: 1 }, bastion: { grain: 2, cristal: 3 } };
export const LIMITS = { sentier: 15, camp: 5, bastion: 4 };
export const PLAYER_DEFS = [
  { nom: 'Corail', col: '#ef6a52' }, { nom: 'Jade', col: '#2fb3a5' },
  { nom: 'Ambre', col: '#f2b52c' }, { nom: 'Indigo', col: '#8a72ff' },
  { nom: 'Azur', col: '#3f9cff' }, { nom: 'Ivoire', col: '#efe9dc' },
];
export const MAX_PLAYERS = 6;
export const SIZE = 1;

/* Hasard : graine pour l'île (reproductible), Math.random pour le reste (tiré par l'hôte) */
export function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let rand = Math.random;
const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
const pick = arr => arr[Math.floor(rand() * arr.length)];

/* ---------- Marées ---------- */
function buildTideDeck() {
  const d = [];
  for (const r of RES) d.push({ type: 'abondance', res: r }, { type: 'disette', res: r }, { type: 'haut', res: r }, { type: 'bas', res: r });
  d.push({ type: 'chantier-sentier', res: 'pierre' }, { type: 'chantier-carnet', res: 'cristal' });
  for (let i = 0; i < 10; i++) d.push({ type: 'calme', res: null });
  return shuffle(d);
}
export function tideTitle(t) {
  if (!t) return '—';
  const n = t.res ? RES_INFO[t.res].nom : '';
  return ({ abondance: `Abondance · ${n}`, disette: `Disette · ${n}`, haut: `Cours haut · ${n}`, bas: `Cours bas · ${n}`,
    'chantier-sentier': 'Chantier · Sentiers', 'chantier-carnet': 'Chantier · Carnets', calme: 'Mer calme' })[t.type];
}
export function tideDesc(t) {
  if (!t) return '';
  const r = t.res ? RES_INFO[t.res] : null;
  return ({
    abondance: `Les tuiles ${r?.terrain} produisent le double de ${r?.nom}.`,
    disette: `Les tuiles ${r?.terrain} ne produisent rien. Les joueurs privés reçoivent un jeton de Fortune.`,
    haut: `La banque prend le ${r?.nom} à 1 contre 1.`,
    bas: `Tous les taux d'échange sur le ${r?.nom} augmentent de 1.`,
    'chantier-sentier': 'Un sentier ne coûte que 1 Bois.',
    'chantier-carnet': 'Les carnets coûtent 1 Cristal de moins (carnets pas encore disponibles).',
    calme: 'Aucun effet. Le Phare échange à 3 contre 1.',
  })[t.type] + (t.res && t.type !== 'chantier-carnet' ? ` Phare : ${r.nom} à 2 contre 1.` : '');
}
function drawTide(S, prevRes) {
  for (let guard = 0; guard < 40; guard++) {
    if (!S.tideDeck.length) S.tideDeck = buildTideDeck();
    const c = S.tideDeck.pop();
    if (c.res && c.res === prevRes && c.type !== 'calme') { S.tideDeck.unshift(c); continue; }
    return c;
  }
  return { type: 'calme', res: null };
}

/* ---------- Génération de l'île ---------- */
const NEIGH = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
function axialToXZ(q, r) { return { x: SIZE * Math.sqrt(3) * (q + r / 2), z: SIZE * 1.5 * r }; }

const isCorner = (q, r, R) => { const s = -q - r; return [Math.abs(q), Math.abs(r), Math.abs(s)].filter(v => v === R).length === 2 && [q, r, s].includes(0); };
export function generateIsland(seed, big = false) {
  const saved = rand; rand = mulberry32(seed);
  const R = big ? 3 : 2;
  const tiles = [];
  for (let q = -R; q <= R; q++) for (let r = -R; r <= R; r++) if (Math.abs(q + r) <= R && !(big && isCorner(q, r, R))) {
    const p = axialToXZ(q, r);
    tiles.push({ id: tiles.length, q, r, x: p.x, z: p.z, terrain: null, number: null, revealed: false, neighbors: [], vertices: [] });
  }
  const key = (q, r) => tiles.findIndex(t => t.q === q && t.r === r);
  for (const t of tiles) t.neighbors = NEIGH.map(([dq, dr]) => key(t.q + dq, t.r + dr)).filter(i => i >= 0);
  const center = tiles.find(t => t.q === 0 && t.r === 0);
  const land = tiles.filter(t => t !== center);

  const counts = big ? TERRAIN_COUNTS_BIG : TERRAIN_COUNTS;
  const bag = []; for (const r of RES) for (let i = 0; i < counts[r]; i++) bag.push(r);
  for (let a = 0; a < 20000; a++) {
    shuffle(bag); land.forEach((t, i) => t.terrain = bag[i]);
    if (land.every(t => t.neighbors.filter(n => tiles[n].terrain === t.terrain).length <= 1)) break;
  }
  center.terrain = 'phare';

  const nums = (big ? NUMBERS_BIG : NUMBERS).slice();
  for (let a = 0; a < 20000; a++) {
    shuffle(nums); land.forEach((t, i) => t.number = nums[i]);
    const ok = land.every(t => t.neighbors.every(n => {
      const o = tiles[n]; if (o.number == null) return true;
      if (o.number === t.number) return false;
      return !((t.number === 6 || t.number === 8) && (o.number === 6 || o.number === 8));
    }));
    if (ok) break;
  }

  const vertices = [], edges = [], vKey = new Map(), eKey = new Map();
  for (const t of tiles) {
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const ang = Math.PI / 180 * (60 * i - 30);
      const x = t.x + SIZE * Math.cos(ang), z = t.z + SIZE * Math.sin(ang);
      const k = `${Math.round(x * 100)},${Math.round(z * 100)}`;
      if (!vKey.has(k)) { vKey.set(k, vertices.length); vertices.push({ id: vertices.length, x, z, tiles: [], adj: [], edges: [], building: null, port: null }); }
      const v = vertices[vKey.get(k)]; v.tiles.push(t.id); ids.push(v.id);
    }
    t.vertices = ids;
    for (let i = 0; i < 6; i++) {
      const a = ids[i], b = ids[(i + 1) % 6];
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!eKey.has(k)) { eKey.set(k, edges.length); edges.push({ id: edges.length, v: [a, b], tiles: [], road: null }); vertices[a].adj.push(b); vertices[b].adj.push(a); vertices[a].edges.push(edges.length - 1); vertices[b].edges.push(edges.length - 1); }
      edges[eKey.get(k)].tiles.push(t.id);
    }
  }

  const coast = edges.filter(e => e.tiles.length === 1).map(e => {
    const a = vertices[e.v[0]], b = vertices[e.v[1]];
    return { e, ang: Math.atan2((a.z + b.z) / 2, (a.x + b.x) / 2) };
  }).sort((p, q) => p.ang - q.ang);
  const portTypes = shuffle(big ? ['3:1', '3:1', '3:1', '3:1', '3:1', ...RES, 'lin'] : ['3:1', '3:1', '3:1', '3:1', ...RES]);
  const nPorts = portTypes.length;
  const offset = Math.floor(rand() * 3);
  const ports = [];
  for (let i = 0; i < nPorts; i++) {
    const e = coast[(Math.round(i * coast.length / nPorts) + offset) % coast.length].e;
    ports.push({ edge: e.id, type: portTypes[i] });
    for (const v of e.v) vertices[v].port = portTypes[i];
  }
  center.revealed = true; for (const n of center.neighbors) tiles[n].revealed = true;
  rand = saved;
  return { tiles, vertices, edges, ports, center: center.id, big };
}

/* ---------- Création d'une partie ---------- */
/* seats : [{ clientId, name }] dans l'ordre des places */
/* quickBuild : les joueurs peuvent construire pendant le tour des autres (parties en ligne à 5-6) */
export function createGame({ seats, win = 10, seed = Math.floor(Math.random() * 1e9), code = null, hostId = null, quickBuild = false }) {
  const n = seats.length;
  const isl = generateIsland(seed, n > 4);
  const S = {
    v: 1, gameId: `${seed}-${Date.now().toString(36)}`, seq: 0, code, hostId, seed, win, quickBuild, ...isl,
    players: seats.map((s, i) => ({ id: i, clientId: s.clientId || null, nom: s.name || PLAYER_DEFS[i].nom, col: PLAYER_DEFS[i].col,
      res: Object.fromEntries(RES.map(r => [r, 0])), fortune: 0, built: { sentier: 0, camp: 0, bastion: 0 } })),
    bank: Object.fromEntries(RES.map(r => [r, n > 4 ? 24 : 19])),
    current: 0, phase: 'setup', round: 0,
    setupOrder: [...Array(n).keys(), ...[...Array(n).keys()].reverse()],
    setupStep: 0, setupSub: 'camp', lastCamp: null,
    robber: isl.center, tideDeck: [], tide: null, nextTide: null, dice: null, winner: null,
  };
  rand = Math.random;
  S.tideDeck = buildTideDeck();
  S.current = S.setupOrder[0];
  return S;
}

/* ---------- Lectures ---------- */
export const total = p => RES.reduce((s, r) => s + p.res[r], 0);
export const vp = p => p.built.camp + 2 * p.built.bastion;
export function costOf(S, kind) {
  if (kind === 'sentier' && S.tide?.type === 'chantier-sentier') return { bois: 1 };
  return BASE_COSTS[kind];
}
export const canPay = (p, cost) => Object.entries(cost).every(([r, n]) => p.res[r] >= n);

export function legalCamps(S, pid, setup = S.phase === 'setup') {
  return S.vertices.filter(v => !v.building && v.adj.every(a => !S.vertices[a].building) &&
    (setup || v.edges.some(e => S.edges[e].road === pid))).map(v => v.id);
}
export function legalRoads(S, pid, setup = S.phase === 'setup') {
  if (setup) return S.lastCamp == null ? [] : S.vertices[S.lastCamp].edges.filter(e => S.edges[e].road == null);
  return S.edges.filter(e => e.road == null && e.v.some(vid => {
    const v = S.vertices[vid];
    if (v.building && v.building.owner === pid) return true;
    if (v.building && v.building.owner !== pid) return false;
    return v.edges.some(e2 => e2 !== e.id && S.edges[e2].road === pid);
  })).map(e => e.id);
}
export const legalBastions = (S, pid) => S.vertices.filter(v => v.building && v.building.owner === pid && v.building.type === 'camp').map(v => v.id);
export const legalRobber = S => S.tiles.filter(t => t.revealed && t.id !== S.robber).map(t => t.id);

export function rateFor(S, pid, r) {
  const tide = S.tide;
  if (tide?.type === 'haut' && tide.res === r) return 1;
  let rate = 4;
  const owned = S.vertices.filter(v => v.building && v.building.owner === pid);
  if (owned.some(v => v.port === '3:1')) rate = 3;
  if (owned.some(v => v.port === r)) rate = 2;
  if (owned.some(v => v.tiles.includes(S.center))) {
    if (tide && tide.res && tide.type !== 'chantier-carnet' && tide.res === r) rate = Math.min(rate, 2);
    else if (!tide || tide.type === 'calme') rate = Math.min(rate, 3);
  }
  if (tide?.type === 'bas' && tide.res === r) rate += 1;
  return rate;
}

/* Construction hors tour : seulement pendant la phase principale du joueur actif */
export const canBuildOutOfTurn = (S, pid) => !!S.quickBuild && S.phase === 'main' && pid !== S.current && pid >= 0;
export function canBuild(S, pid, kind) {
  const p = S.players[pid];
  if (!p || S.phase !== 'main' || (S.current !== pid && !canBuildOutOfTurn(S, pid))) return false;
  if (!canPay(p, costOf(S, kind)) || p.built[kind] >= LIMITS[kind]) return false;
  if (kind === 'sentier') return legalRoads(S, pid).length > 0;
  if (kind === 'camp') return legalCamps(S, pid).length > 0;
  return legalBastions(S, pid).length > 0;
}

/* ---------- Mutations internes ---------- */
function pay(S, p, cost) { for (const [r, n] of Object.entries(cost)) { p.res[r] -= n; S.bank[r] += n; } }
function give(S, p, r, n) { const k = Math.min(n, S.bank[r]); p.res[r] += k; S.bank[r] -= k; return k; }
function reveal(S, ids) { const out = []; for (const id of ids) { const t = S.tiles[id]; if (!t.revealed) { t.revealed = true; out.push(id); } } return out; }
function startRound(S) {
  S.round++;
  const prev = S.tide?.res || null;
  S.tide = S.nextTide || drawTide(S, prev);
  S.nextTide = drawTide(S, S.tide.res);
}
function produce(S, n) {
  const gains = [];
  const demand = Object.fromEntries(RES.map(r => [r, new Map()]));
  for (const t of S.tiles) {
    if (t.number !== n || t.id === S.robber || !RES.includes(t.terrain)) continue;
    if (S.tide?.type === 'disette' && S.tide.res === t.terrain) continue;
    const mult = (S.tide?.type === 'abondance' && S.tide.res === t.terrain) ? 2 : 1;
    for (const vid of t.vertices) {
      const b = S.vertices[vid].building; if (!b) continue;
      const k = (b.type === 'bastion' ? 2 : 1) * mult;
      const m = demand[t.terrain]; m.set(b.owner, (m.get(b.owner) || 0) + k);
      gains.push({ tile: t.id, vertex: vid, owner: b.owner, res: t.terrain, n: k });
    }
  }
  const received = new Set(), blocked = [];
  for (const r of RES) {
    const m = demand[r]; const need = [...m.values()].reduce((a, b) => a + b, 0);
    if (!need) continue;
    if (need > S.bank[r] && m.size > 1) { blocked.push(r); continue; }
    for (const [pid, k] of m) if (give(S, S.players[pid], r, k) > 0) received.add(pid);
  }
  const fortune = [];
  for (const p of S.players) if (!received.has(p.id)) { p.fortune++; fortune.push(p.id); }
  return { gains: gains.filter(g => !blocked.includes(g.res)), fortune, blocked };
}
/* On ne gagne que pendant son propre tour : un seuil atteint hors tour est validé au début de son tour */
function checkWin(S, p, ev) {
  if (p.id === S.current && vp(p) >= S.win) { S.phase = 'over'; S.winner = p.id; ev.push({ k: 'win', pid: p.id }); }
}

/* ---------- Actions ----------
   applyAction(S, pid, action) modifie S et renvoie { ok, error, events }.
   action : {t:'camp',v} {t:'road',e} {t:'bastion',v} {t:'roll'} {t:'robber',tile} {t:'trade',give,get} {t:'end'} */
export function applyAction(S, pid, a) {
  rand = Math.random;
  const ev = [];
  const fail = error => ({ ok: false, error, events: [] });
  if (S.phase === 'over') return fail('La partie est terminée.');
  const p = S.players[pid];
  if (!p) return fail('Joueur inconnu.');
  const outOfTurn = pid !== S.current;
  if (outOfTurn && !(['road', 'camp', 'bastion'].includes(a.t) && canBuildOutOfTurn(S, pid)))
    return fail(S.quickBuild && ['road', 'camp', 'bastion'].includes(a.t) ? 'Vous pourrez construire quand le joueur actif aura lancé les dés.' : "Ce n'est pas votre tour.");

  if (S.phase === 'setup') {
    if (S.setupSub === 'camp' && a.t === 'camp') {
      if (!legalCamps(S, pid, true).includes(a.v)) return fail('Emplacement impossible.');
      S.vertices[a.v].building = { owner: pid, type: 'camp' }; p.built.camp++; S.lastCamp = a.v;
      ev.push({ k: 'camp', v: a.v, pid, setup: true });
      const nw = reveal(S, S.vertices[a.v].tiles); if (nw.length) ev.push({ k: 'reveal', tiles: nw });
      if (S.setupStep >= S.players.length) {
        const got = [];
        for (const tid of S.vertices[a.v].tiles) { const t = S.tiles[tid]; if (RES.includes(t.terrain) && give(S, p, t.terrain, 1)) got.push(t.terrain); }
        if (got.length) ev.push({ k: 'toast', msg: `${p.nom} reçoit ${got.map(r => RES_INFO[r].ic).join(' ')}`, delay: 900 });
      }
      S.setupSub = 'road';
      return { ok: true, events: ev };
    }
    if (S.setupSub === 'road' && a.t === 'road') {
      if (!legalRoads(S, pid, true).includes(a.e)) return fail('Le sentier doit partir de votre nouveau camp.');
      S.edges[a.e].road = pid; p.built.sentier++;
      ev.push({ k: 'road', e: a.e, pid, setup: true, from: S.lastCamp });
      const nw = reveal(S, S.edges[a.e].tiles); if (nw.length) ev.push({ k: 'reveal', tiles: nw });
      S.setupStep++; S.setupSub = 'camp'; S.lastCamp = S.setupStep >= S.setupOrder.length ? null : S.lastCamp;
      if (S.setupStep >= S.setupOrder.length) {
        S.phase = 'roll'; S.current = 0; startRound(S);
        ev.push({ k: 'toast', msg: `Marée : ${tideTitle(S.tide)}. ${tideDesc(S.tide)}`, ms: 4200, delay: 900 });
      } else S.current = S.setupOrder[S.setupStep];
      return { ok: true, events: ev };
    }
    return fail("Action impossible pendant l'installation.");
  }

  if (a.t === 'roll') {
    if (S.phase !== 'roll') return fail('Les dés sont déjà lancés.');
    const d1 = 1 + Math.floor(rand() * 6), d2 = 1 + Math.floor(rand() * 6), n = d1 + d2;
    S.dice = [d1, d2]; ev.push({ k: 'dice', d: [d1, d2], pid });
    if (n === 7) {
      for (const q of S.players) {
        const tot = total(q); if (tot <= 7) continue;
        let k = Math.floor(tot / 2); const lost = k;
        while (k > 0) { const r = pick(RES.filter(x => q.res[x] > 0)); q.res[r]--; S.bank[r]++; k--; }
        ev.push({ k: 'toast', msg: `${q.nom} défausse ${lost} cartes`, delay: 700 });
      }
      ev.push({ k: 'toast', msg: '7 : le Rôdeur sort de la brume', delay: 700 });
      S.phase = 'robber';
      return { ok: true, events: ev };
    }
    const res = produce(S, n);
    ev.push({ k: 'prod', gains: res.gains, fortune: res.fortune });
    if (res.blocked.length) ev.push({ k: 'toast', msg: `La banque manque de ${res.blocked.map(r => RES_INFO[r].nom).join(', ')} : personne n'en reçoit`, delay: 700 });
    if (res.fortune.length) ev.push({ k: 'toast', msg: `✦ Fortune pour ${res.fortune.map(i => S.players[i].nom).join(', ')}`, delay: 1200 });
    S.phase = 'main';
    return { ok: true, events: ev };
  }

  if (a.t === 'robber') {
    if (S.phase !== 'robber') return fail('Le Rôdeur ne peut pas bouger maintenant.');
    if (!legalRobber(S).includes(a.tile)) return fail('Tuile impossible.');
    S.robber = a.tile; ev.push({ k: 'robber', tile: a.tile });
    const victims = S.players.filter(q => q.id !== pid && total(q) > 0 && S.tiles[a.tile].vertices.some(v => S.vertices[v].building?.owner === q.id));
    if (victims.length) {
      const v = pick(victims); const r = pick(RES.filter(x => v.res[x] > 0)); v.res[r]--; p.res[r]++;
      ev.push({ k: 'toast', msg: `Le Rôdeur vole ${RES_INFO[r].ic} à ${v.nom} pour ${p.nom}`, delay: 800 });
    } else ev.push({ k: 'toast', msg: 'Le Rôdeur ne trouve rien à voler', delay: 800 });
    S.phase = 'main';
    return { ok: true, events: ev };
  }

  if (S.phase !== 'main') return fail("Lancez d'abord les dés.");

  if (a.t === 'road') {
    if (!canBuild(S, pid, 'sentier') || !legalRoads(S, pid).includes(a.e)) return fail('Sentier impossible ici.');
    pay(S, p, costOf(S, 'sentier')); S.edges[a.e].road = pid; p.built.sentier++;
    ev.push({ k: 'road', e: a.e, pid });
    const nw = reveal(S, S.edges[a.e].tiles); if (nw.length) ev.push({ k: 'reveal', tiles: nw });
    if (outOfTurn) ev.push({ k: 'toast', msg: `${p.nom} trace un sentier pendant le tour de ${S.players[S.current].nom}` });
    return { ok: true, events: ev };
  }
  if (a.t === 'camp') {
    if (!canBuild(S, pid, 'camp') || !legalCamps(S, pid).includes(a.v)) return fail('Camp impossible ici.');
    pay(S, p, costOf(S, 'camp')); S.vertices[a.v].building = { owner: pid, type: 'camp' }; p.built.camp++;
    ev.push({ k: 'camp', v: a.v, pid });
    const nw = reveal(S, S.vertices[a.v].tiles); if (nw.length) ev.push({ k: 'reveal', tiles: nw });
    if (outOfTurn) ev.push({ k: 'toast', msg: `${p.nom} installe un camp pendant le tour de ${S.players[S.current].nom}` });
    checkWin(S, p, ev);
    return { ok: true, events: ev };
  }
  if (a.t === 'bastion') {
    if (!canBuild(S, pid, 'bastion') || !legalBastions(S, pid).includes(a.v)) return fail('Bastion impossible ici.');
    pay(S, p, costOf(S, 'bastion')); S.vertices[a.v].building.type = 'bastion'; p.built.camp--; p.built.bastion++;
    ev.push({ k: 'bastion', v: a.v, pid });
    if (outOfTurn) ev.push({ k: 'toast', msg: `${p.nom} élève un bastion pendant le tour de ${S.players[S.current].nom}` });
    checkWin(S, p, ev);
    return { ok: true, events: ev };
  }
  if (a.t === 'trade') {
    if (!RES.includes(a.get) || S.bank[a.get] < 1 || a.get === a.give) return fail('Échange impossible.');
    if (a.give === 'fortune') { if (p.fortune < 3) return fail('Il faut 3 jetons de Fortune.'); p.fortune -= 3; }
    else if (RES.includes(a.give)) { const rate = rateFor(S, pid, a.give); if (p.res[a.give] < rate) return fail('Pas assez de cartes.'); p.res[a.give] -= rate; S.bank[a.give] += rate; }
    else return fail('Échange impossible.');
    give(S, p, a.get, 1);
    ev.push({ k: 'bump', pid, res: [a.get] });
    return { ok: true, events: ev };
  }
  if (a.t === 'end') {
    S.current = (S.current + 1) % S.players.length;
    S.dice = null;
    if (S.current === 0) { startRound(S); ev.push({ k: 'toast', msg: `Nouvelle marée : ${tideTitle(S.tide)}. ${tideDesc(S.tide)}`, ms: 4200 }); }
    S.phase = 'roll';
    ev.push({ k: 'turn', pid: S.current });
    checkWin(S, S.players[S.current], ev);
    return { ok: true, events: ev };
  }
  return fail('Action inconnue.');
}
