/* Interface, salons et synchronisation de la partie */
import { RES, RES_INFO, PLAYER_DEFS, MAX_PLAYERS, PIPS, createGame, applyAction, tideTitle, tideDesc, total, vp, costOf, canBuild, canBuildOutOfTurn, canPay, tidesLeft,
  legalCamps, legalRoads, legalBastions, legalRobber, rateFor } from './engine.js';
import { initView, buildView, playEvents, showMarkers, clearMarkers, onTap, viewGameId, resetCamera, markerScreenPositions, debugScene } from './view.js';
import { openRoom } from './net.js';
import { spriteSheet, icon } from './icons.js';

document.body.insertAdjacentHTML('afterbegin', spriteSheet());

const $ = id => document.getElementById(id);
/* Version du build (injectée par scripts/build.mjs) : 'prod' ou 'preview' */
const BUILD = typeof __BRUMES_BUILD__ !== 'undefined' ? __BRUMES_BUILD__ : { channel: 'prod', version: 'dev', date: new Date().toISOString(), sha: '' };
const PREVIEW = BUILD.channel === 'preview';
const KEY = PREVIEW ? 'brumes-preview:' : 'brumes:'; // sauvegardes séparées pour l'aperçu
const params = new URLSearchParams(location.search);
const TRANSPORT = params.get('transport') === 'bc' ? 'bc' : 'supabase';
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* rien */ } },
};
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const ME = { id: params.get('id') || store.get(KEY + 'id') || rid(), name: store.get(KEY + 'name', store.get('brumes:name', '')) };
if (!params.get('id')) store.set(KEY + 'id', ME.id);

/* Session courante */
let session = null; // { mode:'local'|'online', code, room, isHost, lobby, state, peers:Set, win }
let uiMode = null, waiting = false, waitTimer = null, takeoverTimer = null, lastTurnSeen = null;

/* ---------- Messages et petits retours visuels ---------- */
function toast(msg, ms = 2600) {
  const d = document.createElement('div'); d.className = 'toast'; d.innerHTML = rich(msg); $('toasts').appendChild(d);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  setTimeout(() => d.remove(), ms);
}
/* Les messages du moteur citent les ressources par un symbole : on le remplace par notre icône */
const SYMBOLS = { '🪵': 'bois', '🪨': 'pierre', '🧵': 'lin', '🌾': 'grain', '💎': 'cristal', '✦': 'fortune' };
function rich(msg) { return esc(msg).replace(/🪵|🪨|🧵|🌾|💎|✦/gu, m => icon(SYMBOLS[m], 'ico sm')); }
const PIPS_AT = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function setDie(el, n) { el.innerHTML = Array.from({ length: 9 }, (_, i) => `<i class="${PIPS_AT[n].includes(i) ? 'p' : ''}"></i>`).join(''); el.setAttribute('aria-label', String(n)); }
function hint(msg) { $('hintText').textContent = msg || ''; }
function showOverlay(id) { for (const o of document.querySelectorAll('.overlay')) o.classList.toggle('show', o.id === id); }
function hideOverlays() { for (const o of document.querySelectorAll('.overlay')) o.classList.remove('show'); }
function showDice(d) {
  const box = $('dice'); box.classList.remove('land'); box.classList.add('show', 'roll');
  $('d1').classList.remove('seven'); $('d2').classList.remove('seven');
  let ticks = 7;
  const spin = setInterval(() => {
    if (ticks-- > 0) { setDie($('d1'), 1 + Math.floor(Math.random() * 6)); setDie($('d2'), 1 + Math.floor(Math.random() * 6)); return; }
    clearInterval(spin);
    setDie($('d1'), d[0]); setDie($('d2'), d[1]); box.classList.remove('roll'); box.classList.add('land');
    if (d[0] + d[1] === 7) { $('d1').classList.add('seven'); $('d2').classList.add('seven'); }
    setTimeout(() => box.classList.remove('show'), 1200);
  }, 70);
}

/* ---------- Qui suis-je dans la partie ? ---------- */
const S = () => session?.state;
function myPid() {
  const st = S(); if (!st) return -1;
  if (session.mode === 'local') return st.current;
  return st.players.findIndex(p => p.clientId === ME.id);
}
const isMyTurn = () => { const st = S(); return !!st && st.phase !== 'over' && myPid() === st.current && myPid() >= 0; };
/* Construction pendant le tour d'un autre joueur (parties en ligne à 5-6) */
const canQuickBuild = () => { const st = S(); return !!st && session.mode === 'online' && canBuildOutOfTurn(st, myPid()); };

/* ---------- Affichage du HUD ---------- */
let handSnap = null; // dernière main affichée : pour faire tomber les gains
function plateHTML(st, q, me, online) {
  const away = online && q.clientId && session.peers && !session.peers.has(q.clientId);
  const initial = esc((q.nom || '?').trim().charAt(0).toUpperCase());
  return `<div class="plate ${q.id === st.current && st.phase !== 'over' ? 'active' : ''} ${away ? 'away' : ''} ${online && q.id === me ? 'me' : ''}" data-pid="${q.id}">
    <span class="avatar"><span class="face" style="background:${q.col}">${initial}</span>
      <svg class="ring" viewBox="0 0 38 38"><circle class="track" cx="19" cy="19" r="17"/><circle class="left" cx="19" cy="19" r="17" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></svg></span>
    <span class="who"><b>${esc(q.nom)}</b><span class="stats"><span title="Points de victoire">${icon('fortune')}${vp(q)}</span><span title="Cartes en main">${icon('carte')}${total(q)}</span></span></span></div>`;
}
function renderHUD() {
  const st = S(); if (!st) return;
  const me = myPid(), mine = me >= 0 ? st.players[me] : null;
  const online = session.mode === 'online';
  $('players').classList.toggle('three', st.players.length > 4);
  $('players').innerHTML = st.players.map(q => plateHTML(st, q, me, online)).join('');
  // Marée : visible seulement quand elle agit ou qu'elle est annoncée
  const chip = $('tideChip');
  if (st.phase !== 'setup' && (st.tide || st.nextTide)) {
    chip.hidden = false; chip.classList.toggle('soon', !st.tide);
    $('tideTitle').textContent = tideTitle(st.tide || st.nextTide);
    $('tideWhen').textContent = st.tide ? 'ce tour' : 'au prochain tour';
  } else chip.hidden = true;
  // Main : seulement ce qu'on possède
  if (mine) {
    const cards = RES.filter(r => mine.res[r] > 0).map(r => `<div class="rcard r-${r} ${mine.res[r] > 1 ? 'stack' : ''}" data-r="${r}" title="${RES_INFO[r].nom}">${icon(r)}<span class="n">${mine.res[r]}</span></div>`).join('');
    $('hand').innerHTML = (cards || '<div class="empty">Aucune ressource pour l’instant</div>') +
      `<div class="rcard coin" data-r="fortune" title="Jetons de Fortune">${icon('fortune')}<span class="n">${mine.fortune}</span></div>`;
  } else $('hand').innerHTML = '<div class="empty">Vous regardez la partie</div>';
  const mt = isMyTurn() && !waiting;
  const mb = (mt || canQuickBuild()) && !waiting;
  $('btnRoll').disabled = !(mt && st.phase === 'roll');
  $('btnSentier').disabled = !(mb && canBuild(st, me, 'sentier'));
  $('btnCamp').disabled = !(mb && canBuild(st, me, 'camp'));
  $('btnBastion').disabled = !(mb && canBuild(st, me, 'bastion'));
  $('btnBank').disabled = !(mt && st.phase === 'main');
  $('btnEnd').disabled = !(mt && st.phase === 'main');
  $('btnSentier').querySelector('.co').innerHTML = st.tide?.type === 'chantier-sentier' ? icon('bois') : icon('bois') + icon('pierre');
  for (const [id, m] of [['btnSentier', 'sentier'], ['btnCamp', 'camp'], ['btnBastion', 'bastion']]) $(id).classList.toggle('on', uiMode === m);
  $('toasts').style.top = `${Math.round($('top').getBoundingClientRect().bottom + 8)}px`;
  renderOffer(); renderTimer();
}
/* Les cartes gagnées tombent dans la main, avec leur « +N » */
function dropGains() {
  const st = S(), me = myPid(); if (!st || me < 0) { handSnap = null; return; }
  const p = st.players[me], now = { ...p.res, fortune: p.fortune }, key = `${st.gameId}:${me}`;
  const prev = handSnap && handSnap.key === key ? handSnap.v : null;
  handSnap = { key, v: now };
  if (!prev) return;
  let i = 0;
  for (const r of [...RES, 'fortune']) {
    const d = now[r] - prev[r]; if (d <= 0) continue;
    const slot = $('hand').querySelector(`[data-r="${r}"]`); if (!slot) continue;
    const box = slot.getBoundingClientRect();
    const el = document.createElement('div'); el.className = 'drop';
    el.innerHTML = `${icon(r)}<b>+${d}</b>`;
    el.style.left = `${box.left + box.width / 2 - 17}px`; el.style.top = `${box.top + 6}px`; el.style.animationDelay = `${i * 0.12}s`;
    document.body.appendChild(el);
    setTimeout(() => { slot.classList.remove('hit'); void slot.offsetWidth; slot.classList.add('hit'); }, 600 + i * 120);
    setTimeout(() => el.remove(), 1300 + i * 120);
    i++;
  }
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

/* Repères à afficher et message d'aide, selon l'état et le tour */
function refreshInteraction() {
  const st = S(); if (!st) return;
  const me = myPid(), cur = st.players[st.current];
  if (st.phase === 'over') { clearMarkers(); hint(''); return; }
  if (!isMyTurn() || waiting) {
    if (!waiting && canQuickBuild() && uiMode && canBuild(st, me, uiMode)) {
      if (uiMode === 'sentier') { showMarkers('edge', legalRoads(st, me)); hint('Hors tour : touchez un emplacement pour tracer le sentier'); }
      else if (uiMode === 'camp') { showMarkers('vertex', legalCamps(st, me)); hint('Hors tour : touchez une intersection pour installer le camp'); }
      else { showMarkers('vertex', legalBastions(st, me)); hint('Hors tour : touchez un de vos camps pour en faire un bastion'); }
      return;
    }
    clearMarkers(); uiMode = null;
    hint(waiting ? 'Envoi…' : session.mode === 'online' ? `Au tour de ${cur.nom}${canQuickBuild() ? ' · vous pouvez construire' : ''}` : '');
    return;
  }
  if (st.phase === 'setup') {
    const nth = st.setupStep < st.players.length ? '1er' : '2e';
    if (st.setupSub === 'camp') { showMarkers('vertex', legalCamps(st, me, true)); hint(`${cur.nom} : posez votre ${nth} camp`); }
    else { showMarkers('edge', legalRoads(st, me, true)); hint(`${cur.nom} : tracez un sentier depuis ce camp`); }
    return;
  }
  if (st.phase === 'robber') { showMarkers('tile', legalRobber(st)); hint(`${cur.nom} : envoyez le Rôdeur sur une tuile`); return; }
  if (uiMode === 'sentier') { showMarkers('edge', legalRoads(st, me)); hint('Touchez un emplacement lumineux pour tracer le sentier'); return; }
  if (uiMode === 'camp') { showMarkers('vertex', legalCamps(st, me)); hint('Touchez une intersection lumineuse pour installer le camp'); return; }
  if (uiMode === 'bastion') { showMarkers('vertex', legalBastions(st, me)); hint('Touchez un de vos camps pour en faire un bastion'); return; }
  clearMarkers();
  hint(st.phase === 'roll' ? `${cur.nom} : lancez les dés` : `${cur.nom} : construisez ou échangez`);
}
function refreshAll() { renderHUD(); refreshInteraction(); }

/* ---------- Réception d'un nouvel état ---------- */
function onNewState(state, events, sequential) {
  session.state = state;
  syncTimer(state);
  if (session.mode === 'online') store.set(KEY + 'last', { code: session.code, state });
  else store.set(KEY + 'local', state);
  const animate = sequential && viewGameId() === state.gameId;
  if (animate) playEvents(state, events); else buildView(state);
  waiting = false; clearTimeout(waitTimer);
  let delayed = false;
  if (animate) {
    for (const ev of events) {
      if (ev.k === 'toast') setTimeout(() => toast(ev.msg, ev.ms), ev.delay || 0);
      else if (ev.k === 'dice') { showDice(ev.d); delayed = true; }
      else if (ev.k === 'win') setTimeout(() => showWin(ev.pid), 1300);
    }
  } else if (state.phase === 'over' && state.winner != null) showWin(state.winner);
  // Après un lancer, on laisse les dés atterrir avant de faire tomber les cartes
  if (delayed) { refreshInteraction(); setTimeout(() => { refreshAll(); dropGains(); }, 800); }
  else { refreshAll(); dropGains(); }
  // Signal discret quand c'est à moi de jouer
  const turnKey = `${state.gameId}:${state.round}:${state.current}:${state.setupStep}`;
  if (session.mode === 'online' && isMyTurn() && lastTurnSeen !== turnKey) {
    lastTurnSeen = turnKey;
    toast("C'est à vous de jouer");
    try { navigator.vibrate?.(80); } catch { /* vibration indisponible */ }
  }
}
function showWin(pid) {
  const st = S(); const p = st.players[pid];
  $('winTitle').textContent = `${p.nom} remporte l'expédition`;
  $('winText').textContent = `${vp(p)} points en ${st.round} tours de table.`;
  showOverlay('winOverlay');
}


/* ---------- Minuteur de tour ----------
   L'hôte (ou le téléphone en partie locale) fait foi : il fixe l'échéance et joue
   automatiquement à la place du joueur quand le temps est écoulé. Les autres
   téléphones affichent le temps restant reçu avec l'état. */
const TIME_LABEL = v => v ? (v < 60 ? `${v} s` : v % 60 ? `${Math.floor(v / 60)} min ${v % 60}` : `${v / 60} min`) : 'Sans limite';
let deadline = 0, timerKey = null, warned = false, expiredKey = null;
const turnKeyOf = st => st.phase === 'setup' ? `s${st.setupStep}` : `t${st.round}:${st.current}`;
const isReferee = () => session && (session.mode === 'local' || session.isHost);
function syncTimer(st) {
  if (!st || !st.turnTime || st.phase === 'over') { deadline = 0; return; }
  const k = turnKeyOf(st);
  if (isReferee()) {
    if (k !== timerKey || !deadline) { timerKey = k; deadline = Date.now() + st.turnTime * 1000; warned = false; }
    st.timerLeftMs = Math.max(0, deadline - Date.now());
  } else {
    if (k !== timerKey) { timerKey = k; warned = false; }
    deadline = Date.now() + (st.timerLeftMs ?? st.turnTime * 1000);
  }
}
/* Médaillon rond (en bas à droite) + anneau autour de l'avatar du joueur actif */
function renderTimer() {
  const st = S(), el = $('timer');
  const plate = document.querySelector('.plate.active');
  if (!st || !st.turnTime || !deadline || st.phase === 'over') { el.hidden = true; return; }
  const left = Math.max(0, deadline - Date.now()), frac = Math.min(1, left / (st.turnTime * 1000)), low = left <= 10000;
  el.hidden = false; el.classList.toggle('low', low);
  el.querySelector('.left').setAttribute('stroke-dashoffset', (100 * (1 - frac)).toFixed(2));
  const sec = Math.ceil(left / 1000);
  $('timerNum').textContent = sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : String(sec);
  $('timerWho').textContent = isMyTurn() ? 'à vous' : st.players[st.current].nom;
  if (plate) { plate.classList.toggle('low', low); plate.querySelector('.ring .left').setAttribute('stroke-dashoffset', (100 * (1 - frac)).toFixed(2)); }
  return left;
}
function autoPlay(st) {
  const pid = st.current, k = turnKeyOf(st);
  if (expiredKey !== k) { expiredKey = k; toast(`Temps écoulé pour ${st.players[pid].nom}`); }
  let a = null;
  if (st.phase === 'setup') {
    if (st.setupSub === 'camp') {
      const score = v => st.vertices[v].tiles.reduce((n, t) => n + (st.tiles[t].number ? PIPS(st.tiles[t].number) : 0), 0);
      const c = legalCamps(st, pid, true).sort((x, y) => score(y) - score(x)); if (c.length) a = { t: 'camp', v: c[0] };
    } else { const r = legalRoads(st, pid, true); if (r.length) a = { t: 'road', e: r[0] }; }
  } else if (st.phase === 'roll') a = { t: 'roll' };
  else if (st.phase === 'robber') {
    const rivals = t => st.tiles[t].vertices.filter(v => st.vertices[v].building && st.vertices[v].building.owner !== pid).length - 2 * st.tiles[t].vertices.filter(v => st.vertices[v].building?.owner === pid).length;
    const tiles = legalRobber(st).sort((x, y) => rivals(y) - rivals(x)); if (tiles.length) a = { t: 'robber', tile: tiles[0] };
  } else if (st.phase === 'main') a = { t: 'end' };
  if (a) { if (uiMode && pid === myPid()) uiMode = null; hostApply(pid, a); }
}
function tickTimer() {
  const st = S(); if (!st) { $('timer').hidden = true; return; }
  const left = renderTimer();
  if (left == null) return;
  if (left <= 10000 && left > 0 && !warned && isMyTurn()) { warned = true; toast('Plus que 10 secondes'); try { navigator.vibrate?.([60, 80, 60]); } catch { /* indisponible */ } }
  if (left <= 0 && isReferee() && !waiting) autoPlay(st);
}
setInterval(tickTimer, 250);
function setTurnTime(v) {
  const st = S(); if (!st || !isReferee()) return;
  st.turnTime = v; st.seq++; deadline = 0; timerKey = null; syncTimer(st);
  const events = [{ k: 'toast', msg: `Temps par tour : ${TIME_LABEL(v)}` }];
  if (session.mode === 'online') session.room.send({ type: 'state', state: st, events });
  onNewState(st, events, true);
}

/* ---------- Jouer une action ---------- */
function act(action) {
  const st = S(); if (!st) return;
  uiMode = null;
  if (session.mode === 'local' || session.isHost) {
    const pid = session.mode === 'local' ? (action.t === 'respond' ? action.pid ?? st.current : st.current) : myPid();
    hostApply(pid, action);
  } else {
    waiting = true; refreshAll();
    session.room.send({ type: 'action', from: ME.id, action });
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => { waiting = false; toast("Pas de réponse de l'hôte. Réessayez dans un instant."); refreshAll(); session.room.send({ type: 'hello', from: ME.id, name: ME.name }); }, 7000);
  }
}
function hostApply(pid, action) {
  const st = S();
  const res = applyAction(st, pid, action);
  if (!res.ok) { if (pid === myPid()) toast(res.error); else session.room?.send({ type: 'error', to: st.players[pid]?.clientId, msg: res.error }); refreshAll(); return; }
  st.seq++; st.hostId = session.mode === 'online' ? ME.id : null;
  syncTimer(st);
  if (session.mode === 'online') session.room.send({ type: 'state', state: st, events: res.events });
  onNewState(st, res.events, true);
}

onTap((kind, id) => {
  const st = S(); if (!st || waiting) return;
  if (!isMyTurn()) {
    if (!canQuickBuild()) return;
    if (uiMode === 'sentier' && kind === 'edge') return act({ t: 'road', e: id });
    if (uiMode === 'camp' && kind === 'vertex') return act({ t: 'camp', v: id });
    if (uiMode === 'bastion' && kind === 'vertex') return act({ t: 'bastion', v: id });
    return;
  }
  if (st.phase === 'setup') return act(kind === 'vertex' ? { t: 'camp', v: id } : { t: 'road', e: id });
  if (st.phase === 'robber' && kind === 'tile') return act({ t: 'robber', tile: id });
  if (uiMode === 'sentier' && kind === 'edge') return act({ t: 'road', e: id });
  if (uiMode === 'camp' && kind === 'vertex') return act({ t: 'camp', v: id });
  if (uiMode === 'bastion' && kind === 'vertex') return act({ t: 'bastion', v: id });
});
$('btnRoll').onclick = () => act({ t: 'roll' });
$('btnEnd').onclick = () => act({ t: 'end' });
for (const [id, m] of [['btnSentier', 'sentier'], ['btnCamp', 'camp'], ['btnBastion', 'bastion']]) $(id).onclick = () => { uiMode = uiMode === m ? null : m; refreshAll(); };
$('tideChip').onclick = () => { const st = S(); if (!st) return; const t = st.tide || st.nextTide; if (t) toast(`${st.tide ? '' : 'Au prochain tour : '}${tideDesc(t)}`, 4500); };
$('btnMenu').onclick = () => openMenu();

/* ---------- Banque ---------- */
let give_ = null, get_ = null;
function renderBank() {
  const st = S(), me = myPid(), p = st.players[me];
  $('giveGrid').innerHTML = RES.map(r => { const rate = rateFor(st, me, r); return `<button type="button" class="resbtn ${give_ === r ? 'sel' : ''}" data-r="${r}" ${p.res[r] < rate ? 'disabled' : ''}>${icon(r)}${RES_INFO[r].nom}<small>${rate}:1 · ${p.res[r]} en main</small></button>`; }).join('') +
    `<button type="button" class="resbtn ${give_ === 'fortune' ? 'sel' : ''}" data-r="fortune" ${p.fortune < 3 ? 'disabled' : ''}>${icon('fortune')}Fortune<small>3 jetons · ${p.fortune} en main</small></button>`;
  $('getGrid').innerHTML = RES.map(r => `<button type="button" class="resbtn ${get_ === r ? 'sel' : ''}" data-r="${r}" ${st.bank[r] < 1 || r === give_ ? 'disabled' : ''}>${icon(r)}${RES_INFO[r].nom}<small>banque : ${st.bank[r]}</small></button>`).join('');
  const rate = give_ === 'fortune' ? 3 : give_ ? rateFor(st, me, give_) : 0;
  $('tradeSummary').innerHTML = give_ && get_ ? `<b>${rate}</b>${icon(give_)}<span class="arrow">➜</span><b>1</b>${icon(get_)}` : 'Choisissez quoi donner et quoi recevoir';
  $('btnTrade').disabled = !(give_ && get_);
  $('giveGrid').querySelectorAll('button').forEach(b => b.onclick = () => { give_ = b.dataset.r; if (get_ === give_) get_ = null; renderBank(); });
  $('getGrid').querySelectorAll('button').forEach(b => b.onclick = () => { get_ = b.dataset.r; renderBank(); });
}
/* ---------- Échanges entre joueurs ---------- */
let tradeTab = 'players', offerGive = {}, offerWant = {};
function setTab(t) {
  tradeTab = t;
  $('tabPlayers').classList.toggle('sel', t === 'players'); $('tabBank').classList.toggle('sel', t === 'bank');
  $('paneP').hidden = t !== 'players'; $('paneB').hidden = t !== 'bank';
  if (t === 'bank') renderBank(); else renderPick();
}
function renderPick() {
  const st = S(), p = st.players[myPid()];
  const row = (id, bundle, max) => {
    $(id).innerHTML = RES.map(r => { const n = bundle[r] || 0; return `<div>${icon(r)}<span class="cnt ${n ? '' : 'zero'}">${n}</span>
      <span class="pm"><button type="button" data-r="${r}" data-d="-1" ${n ? '' : 'disabled'} aria-label="Moins de ${RES_INFO[r].nom}">−</button><button type="button" data-r="${r}" data-d="1" ${n < max(r) ? '' : 'disabled'} aria-label="Plus de ${RES_INFO[r].nom}">+</button></span></div>`; }).join('');
    $(id).querySelectorAll('button').forEach(b => b.onclick = () => {
      const r = b.dataset.r; bundle[r] = Math.max(0, (bundle[r] || 0) + +b.dataset.d);
      if (bundle[r] && bundle === offerGive) delete offerWant[r]; if (bundle[r] && bundle === offerWant) delete offerGive[r];
      renderPick();
    });
  };
  row('pickGive', offerGive, r => p.res[r]);
  row('pickWant', offerWant, () => 9);
  const ok = Object.values(offerGive).some(n => n > 0) && Object.values(offerWant).some(n => n > 0);
  $('btnPropose').disabled = !ok;
  $('btnPropose').textContent = st.players.length > 2 ? 'Proposer à tous' : 'Proposer';
}
$('btnBank').onclick = () => { give_ = null; get_ = null; offerGive = {}; offerWant = {}; setTab('players'); showOverlay('bankOverlay'); };
$('tabPlayers').onclick = () => setTab('players');
$('tabBank').onclick = () => setTab('bank');
$('btnTradeClose').onclick = hideOverlays;
$('btnPropose').onclick = () => { const a = { t: 'offer', give: { ...offerGive }, want: { ...offerWant } }; hideOverlays(); act(a); };
$('btnBankClose').onclick = hideOverlays;
const bundleIcons = b => Object.entries(b).map(([r, n]) => `<span class="x">${n}</span>${icon(r)}`).join(' ');
/* Bandeau de la proposition en cours : vu par celui qui propose et par les autres */
function renderOffer() {
  const st = S(), panel = $('offerPanel'), o = st?.offer;
  if (!o || st.phase !== 'main') { panel.hidden = true; panel.dataset.id = ''; return; }
  const me = myPid(), local = session.mode === 'local', from = st.players[o.from];
  const mineOffer = local || me === o.from;
  panel.hidden = false;
  if (mineOffer) {
    const rows = st.players.filter(q => q.id !== o.from).map(q => {
      const r = o.responses[q.id], can = canPay(q, o.want);
      let right;
      if (r === 'accept') right = `<button type="button" class="mini yes" data-with="${q.id}">Échanger</button>`;
      else if (r === 'decline') right = '<span class="st">refuse</span>';
      else if (local) right = can ? `<button type="button" class="mini yes" data-acc="${q.id}">${esc(q.nom)} accepte</button>` : '<span class="st">n’a pas les cartes</span>';
      else right = `<span class="st">${can ? 'réfléchit…' : 'n’a pas les cartes'}</span>`;
      return `<div><span class="dot" style="background:${q.col}"></span><b>${esc(q.nom)}</b><span class="st"></span>${right}</div>`;
    }).join('');
    panel.innerHTML = `<div class="deal"><span>${local ? esc(from.nom) + ' donne' : 'Vous donnez'}</span>${bundleIcons(o.give)}<span>contre</span>${bundleIcons(o.want)}</div>
      <div class="who">${rows}</div><button type="button" class="mini no" id="btnCancelOffer">Annuler la proposition</button>`;
    panel.querySelectorAll('[data-with]').forEach(b => b.onclick = () => act({ t: 'confirmOffer', id: o.id, with: +b.dataset.with }));
    panel.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => hostApply(+b.dataset.acc, { t: 'respond', id: o.id, accept: true }));
    $('btnCancelOffer').onclick = () => act({ t: 'cancelOffer' });
  } else if (me >= 0) {
    const r = o.responses[me], can = canPay(st.players[me], o.want);
    panel.innerHTML = `<div class="deal"><span class="dot" style="background:${from.col}"></span><b>${esc(from.nom)}</b><span>donne</span>${bundleIcons(o.give)}<span>contre</span>${bundleIcons(o.want)}</div>` +
      (r ? `<div class="deal"><span class="st">${r === 'accept' ? `Vous avez accepté. ${esc(from.nom)} choisit avec qui échanger…` : 'Vous avez refusé.'}</span></div>`
         : `<div class="row2"><button type="button" class="mini no" id="btnDecline">Refuser</button><button type="button" class="mini yes" id="btnAccept" ${can ? '' : 'disabled'}>${can ? 'Accepter' : 'Cartes manquantes'}</button></div>`);
    if (!r) { $('btnDecline').onclick = () => act({ t: 'respond', id: o.id, accept: false }); $('btnAccept').onclick = () => act({ t: 'respond', id: o.id, accept: true }); }
    if (panel.dataset.id !== o.id && !r) { try { navigator.vibrate?.(40); } catch { /* indisponible */ } }
  } else panel.hidden = true;
  panel.dataset.id = o.id;
}
$('btnTrade').onclick = () => { if (!give_ || !get_) return; const a = { t: 'trade', give: give_, get: get_ }; hideOverlays(); act(a); };

/* ---------- Menu de partie ---------- */
function renderMenuTime() {
  const st = S(); if (!st) return;
  const can = isReferee();
  $('segMenuTime').querySelectorAll('button').forEach(b => { b.classList.toggle('sel', +b.dataset.v === (st.turnTime || 0)); b.disabled = !can; });
  $('menuTimeNote').textContent = can ? "S'applique tout de suite au tour en cours." : "Seul l'hôte peut changer le temps par tour.";
}
$('segMenuTime').querySelectorAll('button').forEach(b => b.onclick = () => { setTurnTime(+b.dataset.v); renderMenuTime(); });
function openMenu() {
  renderMenuTime();
  const online = session?.mode === 'online';
  $('menuCode').textContent = online ? `Partie ${session.code}` : 'Partie sur ce téléphone';
  $('menuInvite').style.display = online ? '' : 'none';
  showOverlay('menuOverlay');
}
$('btnMenuClose').onclick = hideOverlays;
$('menuInvite').onclick = () => shareInvite(session.code);
$('btnLeave').onclick = () => { leave(); goHome(); };
$('btnAgain').onclick = () => { leave(); store.del(KEY + 'last'); store.del(KEY + 'local'); goHome(); };

/* ---------- Salons en ligne ---------- */
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const newCode = () => Array.from({ length: 4 }, () => ALPH[Math.floor(Math.random() * ALPH.length)]).join('');
const WEB_URL = PREVIEW ? 'https://viktorlorain-cloud.github.io/Brumes/preview/' : 'https://viktorlorain-cloud.github.io/Brumes/';
const APK_URL = 'https://github.com/viktorlorain-cloud/Brumes/releases/latest/download/Brumes.apk';
const IN_APP = !!window.Capacitor;
function inviteUrl(code) {
  const u = new URL(IN_APP || !/^https?:$/.test(location.protocol) ? WEB_URL : location.href);
  u.search = `?partie=${code}`; u.hash = ''; return u.toString();
}
async function shareInvite(code) {
  const url = inviteUrl(code), text = `Rejoins ma partie de Brumes : code ${code}`;
  try { if (navigator.share) { await navigator.share({ title: 'Brumes', text, url }); return; } } catch { /* partage annulé */ }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Invitation copiée'); } catch { toast(`Code de la partie : ${code}`); }
}

function leave() {
  clearTimeout(takeoverTimer); clearTimeout(waitTimer); deadline = 0; timerKey = null;
  try { session?.room?.close(); } catch { /* déjà fermé */ }
  session = null; uiMode = null; waiting = false;
  clearMarkers(); hint('');
}
function goHome() { renderHome(); showOverlay('homeOverlay'); }

async function connect(code, isHost, fallbackState = null) {
  session = { mode: 'online', code, isHost, lobby: null, state: null, peers: new Set([ME.id]), room: null };
  $('lobbyStatus').textContent = 'Connexion…';
  try {
    session.room = await openRoom(PREVIEW ? `preview-${code}` : code, ME, { onMessage, onPeers }, TRANSPORT);
  } catch (e) {
    toast('Connexion impossible. Vérifiez le réseau et réessayez.', 4000); session = null; goHome(); return false;
  }
  if (isHost && fallbackState) {
    session.state = fallbackState; fallbackState.hostId = ME.id; fallbackState.seq++;
    session.room.send({ type: 'state', state: fallbackState, events: [] });
    hideOverlays(); onNewState(fallbackState, [], false);
  }
  return true;
}

async function createOnline() {
  if (!requireName()) return;
  const code = newCode();
  showOverlay('lobbyOverlay');
  if (!await connect(code, true)) return;
  session.lobby = { code, hostId: ME.id, seats: [{ clientId: ME.id, name: ME.name }], win: winPts, turnTime: timePref };
  renderLobby(); broadcastLobby();
}
async function joinOnline(code, resumeState = null) {
  if (!requireName()) return;
  code = code.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  if (code.length !== 4) { toast('Le code fait 4 lettres'); return; }
  showOverlay('lobbyOverlay');
  $('lobbyCode').textContent = code; $('lobbySeats').innerHTML = ''; $('btnLaunch').style.display = 'none';
  if (!await connect(code, false)) return;
  let tries = 0;
  const hello = () => {
    if (!session || session.code !== code || session.state || session.lobby) return;
    if (tries++ >= 6) {
      if (resumeState && resumeState.hostId === ME.id) { session.isHost = true; session.state = resumeState; resumeState.seq++; session.room.send({ type: 'state', state: resumeState, events: [] }); hideOverlays(); onNewState(resumeState, [], false); toast('Partie reprise : vous êtes l’hôte'); return; }
      $('lobbyStatus').textContent = "Aucune partie trouvée avec ce code. Vérifiez-le, ou demandez à l'hôte d'ouvrir l'appli.";
      return;
    }
    session.room.send({ type: 'hello', from: ME.id, name: ME.name });
    setTimeout(hello, 1500);
  };
  hello();
}
function broadcastLobby() { if (session?.isHost && session.lobby) session.room.send({ type: 'lobby', lobby: session.lobby }); }

function renderLobby() {
  const l = session.lobby; if (!l) return;
  $('lobbyCode').textContent = l.code;
  $('lobbySeats').innerHTML = l.seats.map((s, i) => `<li><span class="dot" style="background:${PLAYER_DEFS[i].col}"></span><b>${esc(s.name)}</b>${s.clientId === l.hostId ? '<small>hôte</small>' : ''}${s.clientId === ME.id ? '<small>vous</small>' : ''}${session.peers.has(s.clientId) ? '' : '<small class="off">hors ligne</small>'}</li>`).join('') +
    Array.from({ length: MAX_PLAYERS - l.seats.length }, () => '<li class="free"><span class="dot"></span>Place libre</li>').join('');
  const host = session.isHost;
  $('btnLaunch').style.display = host ? '' : 'none';
  $('btnLaunch').disabled = l.seats.length < 2;
  $('lobbyStatus').textContent = host ? (l.seats.length < 2 ? 'Envoyez le code à vos amis pour qu’ils vous rejoignent.' : `Prêt : ${l.seats.length} joueurs, ${l.win} points pour gagner${l.seats.length > 4 ? ', sur la grande île, avec construction pendant le tour des autres' : ''}, temps par tour : ${TIME_LABEL(l.turnTime || 0)}.`) : "En attente que l'hôte lance la partie…";
}
$('btnInvite').onclick = () => session && shareInvite(session.code);
$('btnLobbyLeave').onclick = () => { leave(); goHome(); };
$('btnLaunch').onclick = () => {
  const l = session.lobby; if (!session.isHost || l.seats.length < 2) return;
  const st = createGame({ seats: l.seats, win: l.win, code: l.code, hostId: ME.id, quickBuild: l.seats.length > 4, turnTime: l.turnTime || 0 });
  session.lobby = null; session.state = st; st.seq = 1;
  deadline = 0; timerKey = null; syncTimer(st);
  session.room.send({ type: 'state', state: st, events: [] });
  hideOverlays(); resetCamera(); onNewState(st, [], false);
  toast('La brume cache les terrains. Les numéros restent visibles.', 3600);
};

function onMessage(m) {
  if (!session) return;
  if (m.to && m.to !== ME.id) return;
  if (m.type === 'hello' && session.isHost) {
    if (session.state) { syncTimer(session.state); session.room.send({ type: 'state', state: session.state, events: [] }); return; }
    const l = session.lobby; if (!l) return;
    const seat = l.seats.find(s => s.clientId === m.from);
    if (seat) seat.name = m.name || seat.name;
    else if (l.seats.length < MAX_PLAYERS) l.seats.push({ clientId: m.from, name: m.name || PLAYER_DEFS[l.seats.length].nom });
    else { session.room.send({ type: 'error', to: m.from, msg: `La partie est complète (${MAX_PLAYERS} joueurs).` }); return; }
    renderLobby(); broadcastLobby();
    return;
  }
  if (m.type === 'lobby' && !session.isHost && !session.state) { session.lobby = m.lobby; renderLobby(); return; }
  if (m.type === 'action' && session.isHost && session.state) {
    const pid = session.state.players.findIndex(p => p.clientId === m.from);
    if (pid < 0) { session.room.send({ type: 'error', to: m.from, msg: 'Vous regardez cette partie sans y jouer.' }); return; }
    hostApply(pid, m.action); return;
  }
  if (m.type === 'state') {
    const cur = S(), st = m.state;
    if (cur && cur.gameId === st.gameId && st.seq <= cur.seq) {
      if (session.isHost && st.hostId !== ME.id && st.seq === cur.seq) { session.room.send({ type: 'state', state: cur, events: [] }); }
      return;
    }
    if (session.isHost && st.hostId !== ME.id) session.isHost = false;
    const sequential = !!cur && cur.gameId === st.gameId && st.seq === cur.seq + 1;
    session.lobby = null;
    if (document.getElementById('lobbyOverlay').classList.contains('show')) { hideOverlays(); resetCamera(); }
    onNewState(st, m.events || [], sequential);
    return;
  }
  if (m.type === 'error') { waiting = false; clearTimeout(waitTimer); toast(m.msg, 3500); refreshAll(); }
}

function onPeers(ids) {
  if (!session) return;
  session.peers = new Set(ids);
  if (session.lobby) renderLobby();
  if (session.state) renderHUD();
  // Si l'hôte disparaît pendant la partie, le joueur connecté le mieux placé reprend l'arbitrage
  const st = S();
  if (!st || session.isHost || !st.hostId || session.peers.has(st.hostId)) { clearTimeout(takeoverTimer); takeoverTimer = null; return; }
  if (takeoverTimer) return;
  takeoverTimer = setTimeout(() => {
    takeoverTimer = null;
    const s2 = S(); if (!session || !s2 || session.isHost || session.peers.has(s2.hostId)) return;
    const present = s2.players.filter(p => session.peers.has(p.clientId)).map(p => p.id);
    if (!present.length || s2.players[present[0]].clientId !== ME.id) return;
    session.isHost = true; s2.hostId = ME.id; s2.seq++;
    const events = [{ k: 'toast', msg: `${s2.players[present[0]].nom} reprend l’arbitrage de la partie` }];
    session.room.send({ type: 'state', state: s2, events });
    onNewState(s2, events, false);
    toast('L’hôte est parti : votre téléphone arbitre maintenant la partie', 4000);
  }, 6000);
}

/* ---------- Partie locale ---------- */
function startLocal(n) {
  leave();
  const seats = PLAYER_DEFS.slice(0, n).map(d => ({ name: d.nom }));
  deadline = 0; timerKey = null;
  session = { mode: 'local', state: createGame({ seats, win: winPts, turnTime: timePref }) };
  hideOverlays(); resetCamera(); onNewState(session.state, [], false);
  toast('La brume cache les terrains. Les numéros restent visibles.', 3600);
}

/* ---------- Écran d'accueil ---------- */
let winPts = 10, localN = 3, timePref = store.get(KEY + 'turnTime', 90);
function requireName() {
  const n = $('nameInput').value.trim().slice(0, 12);
  if (!n) { toast('Choisissez un nom pour que vos amis vous reconnaissent'); $('nameInput').focus(); return false; }
  ME.name = n; store.set(KEY + 'name', n); return true;
}
function renderHome() {
  $('nameInput').value = ME.name || '';
  const last = store.get(KEY + 'last'), local = store.get(KEY + 'local');
  const canResume = last && last.state && last.state.phase !== 'over' && last.state.players.some(p => p.clientId === ME.id);
  $('btnResume').style.display = canResume ? '' : 'none';
  if (canResume) $('btnResume').textContent = `Reprendre la partie ${last.code}`;
  $('btnResumeLocal').style.display = local && local.phase !== 'over' ? '' : 'none';
  if (params.get('partie')) $('codeInput').value = params.get('partie').toUpperCase().slice(0, 4);
}
$('segTime').querySelectorAll('button').forEach(b => b.classList.toggle('sel', +b.dataset.v === timePref));
for (const [seg, set] of [['segWin', v => winPts = v], ['segLocal', v => localN = v], ['segTime', v => { timePref = v; store.set(KEY + 'turnTime', v); }]]) {
  $(seg).querySelectorAll('button').forEach(b => b.onclick = () => { $(seg).querySelectorAll('button').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); set(+b.dataset.v); });
}
$('btnCreate').onclick = createOnline;
$('btnJoin').onclick = () => joinOnline($('codeInput').value);
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinOnline($('codeInput').value); });
$('btnLocal').onclick = () => startLocal(localN);
$('btnResume').onclick = () => { const last = store.get(KEY + 'last'); if (!requireName()) return; joinOnline(last.code, last.state); };
$('btnResumeLocal').onclick = () => { leave(); deadline = 0; timerKey = null; session = { mode: 'local', state: store.get(KEY + 'local') }; hideOverlays(); resetCamera(); onNewState(session.state, [], false); };

/* Installation sur l'écran d'accueil */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('btnInstall').style.display = ''; });
$('btnInstall').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => null); installEvt = null; $('btnInstall').style.display = 'none'; };
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (standalone || IN_APP) $('installHelp').style.display = 'none';
if (!IN_APP && /Android/i.test(navigator.userAgent)) { $('btnApk').href = APK_URL; $('btnApk').style.display = ''; }
if ('serviceWorker' in navigator && location.protocol === 'https:' && !IN_APP && !PREVIEW) navigator.serviceWorker.register('./sw.js').catch(() => null);

/* Aperçu de test : bandeau de version et lien vers les nouveautés */
if (PREVIEW) {
  const when = new Date(BUILD.date).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  for (const id of ['previewHome', 'previewMenu']) { const el = $(id); el.hidden = false; el.querySelector('b').textContent = `Aperçu de test · ${when}`; }
}

/* ---------- Démarrage ---------- */
initView($('scene'));
const homeIsland = createGame({ seats: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], seed: 20261107 });
buildView(homeIsland);
// Les numéros du plateau sont dessinés avec la police du jeu : on redessine l'île d'accueil quand elle est chargée
document.fonts?.load('700 40px Fredoka').then(() => { if (!session) buildView(homeIsland); }).catch(() => null);
goHome();
if (params.get('partie')) $('codeInput').focus();

/* Accès pour les tests automatiques */
window.__brumes = { get session() { return session; }, ME, markerScreenPositions, act, hostApply, legalCamps, legalRoads, setTurnTime, debugScene };
