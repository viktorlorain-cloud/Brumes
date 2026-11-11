/* Interface, salons et synchronisation de la partie */
import { RES, RES_INFO, PLAYER_DEFS, MAX_PLAYERS, PIPS, LIMITS, createGame, applyAction, tideTitle, tideDesc, isWeather, total, vp, costOf, canBuild, canBuildOutOfTurn, canPay, tidesLeft,
  legalCamps, legalRoads, legalBastions, legalRobber, rateFor, randomDiscard, MAPS, SIZES, generateIsland } from './engine.js';
import { initView, buildView, playEvents, showMarkers, clearMarkers, onTap, onLongPress, onInfo, viewGameId, resetCamera, markerScreenPositions, debugScene } from './view.js';
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
/* Fiche d'un joueur, organisée comme dans les jeux du genre : points + nom, puis cartes, Fortune et pièces restantes */
function plateHTML(st, q, me, online) {
  const away = online && q.clientId && session.peers && !session.peers.has(q.clientId);
  const active = q.id === st.current && st.phase !== 'over';
  const mine = online ? q.id === me : false;
  const pieces = k => LIMITS[k] - (q.built?.[k] || 0);
  return `<div class="pc ${active ? 'active' : ''} ${away ? 'away' : ''} ${mine ? 'me' : ''}" data-pid="${q.id}" style="--c:${q.col}">
    <div class="pc-head"><span class="vp" title="Points de victoire">${vp(q)}</span><b>${esc(q.nom)}</b></div>
    <div class="pc-row"><span title="Cartes en main">${icon('carte')}${total(q)}</span><span title="Jetons de Fortune">${icon('fortune')}${q.fortune}</span></div>
    <div class="pc-row bonus"><span class="${q.chemin ? 'held' : ''}" title="Plus long sentier${q.chemin ? ' · Grand Chemin (+2)' : ''}">${icon('sentier')}${q.roadLen || 0}</span><span class="${q.rodeur ? 'held' : ''}" title="Rôdeur déplacé${q.rodeur ? ' · Maître du Rôdeur (+2)' : ''}">${icon('voleur')}${q.robberMoves || 0}</span></div>
    <div class="pc-row pieces"><span title="Sentiers restants">${icon('sentier')}${pieces('sentier')}</span><span title="Camps restants">${icon('camp')}${pieces('camp')}</span><span title="Bastions restants">${icon('bastion')}${pieces('bastion')}</span></div>
    ${active ? '<div class="call"><span class="step"></span><b class="clock" hidden></b></div>' : ''}</div>`;
}
/* Étape en cours du joueur actif, affichée dans sa bulle */
function stepLabel(st) {
  if (st.phase === 'setup') return st.setupSub === 'camp' ? 'Pose un camp' : 'Trace un sentier';
  if (st.phase === 'roll') return 'Lance les dés';
  if (st.phase === 'robber') return 'Déplace le Rôdeur';
  if (st.phase === 'discard') return 'Défausses en cours';
  if (st.offer) return 'Propose un échange';
  return 'Construit';
}
function renderHUD() {
  const st = S(); if (!st) return;
  const me = myPid(), mine = me >= 0 ? st.players[me] : null;
  const online = session.mode === 'online';
  $('players').classList.toggle('six', st.players.length > 4);
  $('players').style.setProperty('--n', st.players.length);
  renderBankBar(st);
  $('players').innerHTML = st.players.map(q => plateHTML(st, q, me, online)).join('');
  // Marée : visible seulement quand elle agit ou qu'elle est annoncée
  const chip = $('tideChip');
  if (st.phase !== 'setup' && (st.tide || st.nextTide)) {
    chip.hidden = false; chip.classList.toggle('soon', !st.tide);
    $('tideTitle').textContent = tideTitle(st.tide || st.nextTide);
    chip.querySelector('span').textContent = isWeather(st.tide || st.nextTide) ? '❄' : '≈';
    $('tideWhen').textContent = st.tide ? 'ce tour' : 'au prochain tour';
  } else chip.hidden = true;
  // Main : seulement ce qu'on possède. Pendant son tour, toucher une carte la met dans « Je donne »
  const canTrade = isMyTurn() && !waiting && st.phase === 'main';
  clampPick(mine);
  if (mine) {
    const card = (r, cls, n) => { const k = give[r] || 0;
      const layers = Array.from({ length: Math.min(n - 1, 4) }, (_, i) => `${2 * i + 2}px ${-2 * i - 2}px 0 -1px var(--rc), ${2 * i + 2}px ${-2 * i - 2}px 0 0 rgba(8,18,26,.6)`).join(', ');
      return `<button type="button" class="rcard ${cls} ${k ? 'picked' : ''} ${canTrade ? 'pickable' : ''}" style="--k:${Math.min(n, 8)};${layers && r !== 'fortune' ? `--stack:${layers}` : ''}" data-r="${r}" title="${r === 'fortune' ? 'Jetons de Fortune' : RES_INFO[r].nom}" ${canTrade ? '' : 'tabindex="-1"'}>${icon(r)}<span class="n">${n}</span>${k ? `<span class="sel">${k}</span>` : ''}</button>`; };
    const cards = RES.filter(r => mine.res[r] > 0).map(r => card(r, `r-${r}`, mine.res[r])).join('');
    $('hand').innerHTML = (cards || '<div class="empty">Aucune ressource</div>') + (mine.fortune ? card('fortune', 'coin', mine.fortune) : '');
    $('hand').querySelectorAll('.rcard').forEach(b => b.onclick = () => pickCard(b.dataset.r));
    fitHand();
  } else $('hand').innerHTML = '<div class="empty">Vous regardez la partie</div>';
  const mt = isMyTurn() && !waiting;
  const rolling = st.phase === 'roll' || st.phase === 'setup';
  $('btnRoll').hidden = !rolling; $('btnEnd').hidden = rolling;
  $('btnRoll').disabled = !(mt && st.phase === 'roll');
  $('btnEnd').disabled = !(mt && st.phase === 'main');
  $('btnBank').disabled = !canTrade;
  $('btnBuild').disabled = !(mt && st.phase === 'main');
  if (!canTrade) tradeOpen = false;
  if ($('btnBuild').disabled) buildOpen = false;
  $('btnSentier').disabled = !canBuild(st, me, 'sentier');
  $('btnCamp').disabled = !canBuild(st, me, 'camp');
  $('btnBastion').disabled = !canBuild(st, me, 'bastion');
  const costHTML = k => Object.entries(costOf(st, k)).flatMap(([r, n]) => Array(n).fill(icon(r))).join('');
  for (const [id, k] of [['btnSentier', 'sentier'], ['btnCamp', 'camp'], ['btnBastion', 'bastion']]) $(id).querySelector('.co').innerHTML = costHTML(k);
  $('btnBuild').classList.toggle('on', buildOpen || !!uiMode);
  $('btnBank').classList.toggle('on', tradeOpen);
  const nGive = Object.values(give).reduce((x, y) => x + y, 0);
  $('btnBank').querySelector('.badge')?.remove();
  if (nGive && !tradeOpen) $('btnBank').insertAdjacentHTML('beforeend', `<span class="badge">${nGive}</span>`);
  $('buildPanel').hidden = !buildOpen;
  $('tradePanel').hidden = !tradeOpen;
  document.body.classList.toggle('drawer-open', tradeOpen || buildOpen);
  if (tradeOpen) renderTrade();
  for (const [id, m] of [['btnSentier', 'sentier'], ['btnCamp', 'camp'], ['btnBastion', 'bastion']]) $(id).classList.toggle('on', uiMode === m);
  renderOffer(); renderTimer(); renderCosts();
  const call = document.querySelector('.pc.active .call');
  $('toasts').style.top = `${Math.round(Math.max($('top').getBoundingClientRect().bottom, call ? call.getBoundingClientRect().bottom : 0) + 8)}px`;
}
/* La main tient toujours à côté des trois boutons : si la place manque, les piles se chevauchent */
function fitHand() {
  const hand = $('hand'), cards = [...hand.querySelectorAll('.rcard')];
  hand.style.setProperty('--gap', '8px');
  if (cards.length < 2) return;
  const avail = hand.clientWidth - 8 - 2 - 10, used = cards.reduce((w, c) => w + c.offsetWidth, 0);
  const gap = Math.min(8, Math.floor((avail - used) / (cards.length - 1)));
  hand.style.setProperty('--gap', `${gap}px`);
}
window.addEventListener('resize', () => { if (S()) fitHand(); });
/* Banque : cartes restantes de chaque ressource */
function renderBankBar(st) {
  $('bankBar').innerHTML = `${icon('banque')}` + RES.map(r => `<span class="${st.bank[r] <= 3 ? 'low' : ''}" title="${RES_INFO[r].nom} en banque">${icon(r)}${st.bank[r]}</span>`).join('');
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
  if (st.phase === 'discard') {
    clearMarkers(); uiMode = null;
    const names = Object.keys(st.discard || {}).map(i => st.players[i].nom);
    hint(`En attente de la défausse : ${names.join(', ')}`);
    return;
  }
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
  // Si on a de quoi construire, les emplacements possibles s'allument d'eux-mêmes
  if (st.phase === 'main' && !st.offer) {
    const sug = suggestions(st, me);
    if (sug.length) {
      clearMarkers();
      for (const [kind, ids] of sug) showMarkers(kind, ids, true);
      const what = sug.map(x => ({ sentier: 'sentier', camp: 'camp', bastion: 'bastion' })[x[2]]).join(', ');
      hint(`Vous pouvez construire (${what}) : touchez un emplacement lumineux`);
      return;
    }
  }
  clearMarkers();
  hint(st.phase === 'roll' ? `${cur.nom} : lancez les dés` : `${cur.nom} : construisez ou échangez`);
}
/* Constructions possibles tout de suite : [type de repère, emplacements, nom] */
function suggestions(st, me) {
  const out = [];
  if (canBuild(st, me, 'bastion')) { const v = legalBastions(st, me); if (v.length) out.push(['vertex', v, 'bastion']); }
  if (canBuild(st, me, 'camp')) { const v = legalCamps(st, me); if (v.length) out.push(['vertex', v, 'camp']); }
  if (canBuild(st, me, 'sentier')) { const e = legalRoads(st, me); if (e.length) out.push(['edge', e, 'sentier']); }
  return out;
}
let closedAt = 0; // un toucher qui ferme un panneau ne construit rien
function refreshAll() { renderHUD(); refreshInteraction(); renderDiscard(); renderClaim(); }

/* ---------- Défausse sur un 7 : chaque joueur concerné choisit ses cartes ---------- */
let discardPick = {}, discardFor = null;
function discardPid() {
  const st = S(); if (!st || st.phase !== 'discard' || !st.discard) return -1;
  if (session.mode === 'local') { const k = Object.keys(st.discard); return k.length ? +k[0] : -1; }
  const me = myPid(); return st.discard[me] != null ? me : -1;
}
function renderDiscard() {
  const ov = $('discardOverlay'), pid = discardPid();
  if (pid < 0 || waiting) { if (ov.classList.contains('show')) ov.classList.remove('show'); discardFor = null; return; }
  const st = S(), p = st.players[pid], need = st.discard[pid];
  if (discardFor !== `${st.seq}:${pid}`) { if (!discardFor || !discardFor.endsWith(`:${pid}`)) discardPick = {}; discardFor = `${st.seq}:${pid}`; }
  const n = Object.values(discardPick).reduce((a, b) => a + b, 0);
  $('discardTitle').textContent = session.mode === 'local' ? `${p.nom} : défaussez ${need} cartes` : `Défaussez ${need} cartes`;
  $('discardText').textContent = `Vous avez ${total(p)} cartes, plus de 7 : choisissez la moitié à rendre à la banque. ${n} / ${need} choisies.`;
  $('pickDiscard').innerHTML = RES.map(r => { const k = discardPick[r] || 0; return `<div>${icon(r)}<span class="cnt ${k ? '' : 'zero'}">${k}</span><small class="of">/ ${p.res[r]}</small>
    <span class="pm"><button type="button" data-r="${r}" data-d="-1" ${k ? '' : 'disabled'} aria-label="Garder un ${RES_INFO[r].nom}">−</button><button type="button" data-r="${r}" data-d="1" ${k < p.res[r] && n < need ? '' : 'disabled'} aria-label="Défausser un ${RES_INFO[r].nom}">+</button></span></div>`; }).join('');
  $('pickDiscard').querySelectorAll('button').forEach(b => b.onclick = () => { const r = b.dataset.r; discardPick[r] = Math.max(0, (discardPick[r] || 0) + +b.dataset.d); renderDiscard(); });
  $('btnDiscard').disabled = n !== need;
  $('btnDiscard').textContent = n === need ? `Défausser ${need} cartes` : `Encore ${need - n} à choisir`;
  if (!ov.classList.contains('show')) { for (const o of document.querySelectorAll('.overlay')) if (o !== ov) o.classList.remove('show'); ov.classList.add('show'); }
}
$('btnDiscard').onclick = () => {
  const pid = discardPid(); if (pid < 0) return;
  const cards = Object.fromEntries(Object.entries(discardPick).filter(([, k]) => k > 0));
  discardPick = {}; discardFor = null; $('discardOverlay').classList.remove('show');
  act({ t: 'discard', cards, pid });
};

/* ---------- Réception d'un nouvel état ---------- */
function onNewState(state, events, sequential) {
  session.state = state;
  document.body.classList.remove('home');
  const pk = `${state.gameId}:${state.round}:${state.current}`;
  if (pk !== pickTurn) { pickTurn = pk; give = {}; want = {}; tradeOpen = false; buildOpen = false; }
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
/* Bulle sous la fiche du joueur actif : étape en cours et temps restant */
function renderTimer() {
  const st = S(), call = document.querySelector('.pc.active .call');
  if (!st || !call) return null;
  call.querySelector('.step').textContent = stepLabel(st);
  const clock = call.querySelector('.clock');
  if (!st.turnTime || !deadline || st.phase === 'over') { clock.hidden = true; call.classList.remove('low'); return null; }
  const left = Math.max(0, deadline - Date.now()), sec = Math.ceil(left / 1000);
  clock.hidden = false;
  clock.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  call.classList.toggle('low', left <= 10000);
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
  else if (st.phase === 'discard') {
    for (const id of Object.keys(st.discard || {})) hostApply(+id, randomDiscard(st, +id));
    return;
  }
  else if (st.phase === 'robber') {
    const rivals = t => st.tiles[t].vertices.filter(v => st.vertices[v].building && st.vertices[v].building.owner !== pid).length - 2 * st.tiles[t].vertices.filter(v => st.vertices[v].building?.owner === pid).length;
    const tiles = legalRobber(st).sort((x, y) => rivals(y) - rivals(x)); if (tiles.length) a = { t: 'robber', tile: tiles[0] };
  } else if (st.phase === 'main') a = { t: 'end' };
  if (a) { if (uiMode && pid === myPid()) uiMode = null; hostApply(pid, a); }
}
/* Le Rôdeur surgit à l'écran de celui qui tarde à le placer (une fois par 7) */
const SCARE_AFTER = 12000;
let robberKey = null, robberSince = 0, scared = null;
function growl() {
  try {
    const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
    const ac = growl.ac || (growl.ac = new A()), t = ac.currentTime;
    const o = ac.createOscillator(), g = ac.createGain(), f = ac.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.9);
    f.type = 'lowpass'; f.frequency.value = 600;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(f).connect(g).connect(ac.destination); o.start(t); o.stop(t + 1.2);
  } catch { /* son indisponible */ }
}
function jumpScare() {
  const el = $('scare'); el.hidden = false;
  el.querySelectorAll('*').forEach(n => { n.style.animation = 'none'; void n.offsetWidth; n.style.animation = ''; });
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  document.body.classList.remove('shake'); void document.body.offsetWidth; document.body.classList.add('shake');
  growl();
  try { navigator.vibrate?.([120, 60, 200]); } catch { /* indisponible */ }
  setTimeout(() => { el.hidden = true; document.body.classList.remove('shake'); }, 1650);
}
function watchRobber(st) {
  if (st.phase !== 'robber') { robberKey = null; return; }
  const k = `${st.gameId}:${st.round}:${st.current}`;
  if (k !== robberKey) { robberKey = k; robberSince = Date.now(); }
  if (scared !== k && isMyTurn() && Date.now() - robberSince > SCARE_AFTER) { scared = k; jumpScare(); }
}
function tickTimer() {
  const st = S(); if (!st) return;
  watchRobber(st);
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
    const pid = session.mode === 'local' ? (['respond', 'discard'].includes(action.t) ? action.pid ?? st.current : st.current) : myPid();
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
  // Emplacement proposé automatiquement
  if (!uiMode && st.phase === 'main' && performance.now() - closedAt > 500) {
    if (kind === 'edge') return act({ t: 'road', e: id });
    if (kind === 'vertex') return act(st.vertices[id].building?.owner === myPid() ? { t: 'bastion', v: id } : { t: 'camp', v: id });
  }
});
$('btnRoll').onclick = () => act({ t: 'roll' });
$('btnEnd').onclick = () => act({ t: 'end' });
for (const [id, m] of [['btnSentier', 'sentier'], ['btnCamp', 'camp'], ['btnBastion', 'bastion']]) $(id).onclick = () => { uiMode = uiMode === m ? null : m; buildOpen = false; refreshAll(); };
$('btnBuild').onclick = () => { buildOpen = !buildOpen; tradeOpen = false; if (!buildOpen) uiMode = null; refreshAll(); };
$('tideChip').onclick = () => { const st = S(); if (!st) return; const t = st.tide || st.nextTide; if (t) toast(`${st.tide ? '' : 'Au prochain tour : '}${tideDesc(t)}`, 4500); };
$('btnMenu').onclick = () => openMenu();

/* ---------- Coûts de construction : carte en haut à droite et appui long sur une pièce posée ---------- */
const PIECES = {
  sentier: { nom: 'Sentier', ico: 'sentier', pts: "pour s'étendre" },
  camp: { nom: 'Camp', ico: 'camp', pts: '1 point' },
  bastion: { nom: 'Bastion', ico: 'bastion', pts: '2 points · sur un camp' },
};
const costIcons = (st, k) => Object.entries(costOf(st, k)).flatMap(([r, n]) => Array(n).fill(icon(r))).join('');
let costOpen = false;
function renderCosts() {
  const st = S(), panel = $('costPanel');
  $('btnCosts').classList.toggle('on', costOpen);
  if (!costOpen || !st) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '<h3>Coûts de construction</h3>' + Object.entries(PIECES).map(([k, p]) =>
    `<div class="costRow">${icon(p.ico)}<span><b>${p.nom}</b><small>${p.pts}</small></span><span class="costs">${costIcons(st, k)}</span></div>`).join('') +
    (st.tide?.type === 'chantier-sentier' ? '<div class="note">Marée en cours : le sentier coûte moins cher.</div>' : '') +
    `<div class="costRow">${icon('sentier')}<span><b>Grand Chemin</b><small>plus long sentier, 5 min.</small></span><span class="costs"><b>+2</b></span></div>` +
    `<div class="costRow">${icon('voleur')}<span><b>Maître du Rôdeur</b><small>Rôdeur déplacé 3 fois min.</small></span><span class="costs"><b>+2</b></span></div>`;
}
$('btnCosts').onclick = () => { costOpen = !costOpen; renderCosts(); };
/* Toucher ailleurs sur l'écran ferme ce qui est ouvert (échange, construction, coûts, bulle, menu, règles) */
document.addEventListener('pointerdown', e => {
  const t = e.target, inside = sel => !!t.closest?.(sel);
  let hud = false;
  if (tradeOpen && !inside('#tradePanel, #btnBank, #hand')) { tradeOpen = false; hud = true; }
  if (buildOpen && !inside('#buildPanel, #btnBuild')) { buildOpen = false; hud = true; }
  if (costOpen && !inside('#costPanel, #btnCosts')) { costOpen = false; renderCosts(); }
  if (!$('pieceTip').hidden && !inside('#pieceTip')) $('pieceTip').hidden = true;
  if (hud) closedAt = performance.now();
  if (hud && S()) refreshAll();
}, true);
for (const id of ['menuOverlay', 'rulesOverlay']) $(id).addEventListener('click', e => {
  if (e.target !== e.currentTarget) return; // seulement le fond, pas la fenêtre elle-même
  if (id === 'rulesOverlay' && !session) goHome(); else hideOverlays();
});
$('costPanel').onclick = () => { costOpen = false; renderCosts(); };
let tipTimer = 0;
function showTip(html, x, y, ms = 2600, wide = false) {
  const tip = $('pieceTip');
  tip.innerHTML = html; tip.classList.toggle('wide', wide);
  tip.style.left = `${Math.min(window.innerWidth - (wide ? 140 : 100), Math.max(wide ? 140 : 100, x))}px`; tip.style.top = `${Math.max(150, y)}px`;
  tip.hidden = false; tip.style.animation = 'none'; void tip.offsetWidth; tip.style.animation = '';
  clearTimeout(tipTimer); tipTimer = setTimeout(() => { tip.hidden = true; }, ms);
}
/* Toucher un port ou le Phare : ses avantages en bref */
onInfo((kind, type, x, y) => {
  const st = S(); if (!st) return;
  let html;
  if (kind === 'port' && type === '3:1') html = `<b>Comptoir 3:1</b><small>Avec un camp ou un bastion sur l'un de ses deux emplacements, vous échangez à la banque 3 cartes identiques contre 1 au choix, au lieu de 4.</small>`;
  else if (kind === 'port') html = `<b>Crique 2:1 · ${RES_INFO[type].nom} ${icon(type, 'ico sm')}</b><small>Avec un camp ou un bastion sur l'un de ses deux emplacements, vous échangez à la banque 2 ${RES_INFO[type].nom} contre 1 carte au choix.</small>`;
  else {
    const t = st.tide, now = t?.res && t.type !== 'chantier-carnet' ? `En ce moment : 2 ${RES_INFO[t.res].nom} ${icon(t.res, 'ico sm')} contre 1.` : 'En ce moment, sans marée : 3 cartes identiques contre 1.';
    html = `<b>Le Phare</b><small>Un camp ou un bastion qui touche le Phare échange à 2 contre 1 la ressource de la marée en cours, et à 3 contre 1 quand il n'y a pas de marée. Le Rôdeur part d'ici.</small><small class="now">${now}</small>`;
  }
  showTip(html, x, y, 4500, true);
});
onLongPress((kind, id, x, y) => {
  const st = S(); if (!st) return;
  let k, owner;
  if (kind === 'vertex') { const b = st.vertices[id].building; k = b.type; owner = b.owner; } else { k = 'sentier'; owner = st.edges[id].road; }
  const p = PIECES[k], who = st.players[owner];
  showTip(`<b>${p.nom} de ${esc(who.nom)}</b><small>${p.pts}</small><div class="costs">${costIcons(st, k)}</div>`, x, y);
  try { navigator.vibrate?.(15); } catch { /* indisponible */ }
});

/* ---------- Échanges : une seule section qui monte au-dessus de la barre ----------
   On touche ses cartes pour remplir « Je donne », on choisit « Je veux », puis Joueurs (proposition à tous)
   ou Banque (taux déjà défini : banque, crique, comptoir, Phare, marée ; ou 3 jetons de Fortune). */
let give = {}, want = {}, tradeOpen = false, buildOpen = false, pickTurn = null;
function clampPick(p) {
  if (!p) { give = {}; return; }
  for (const r of Object.keys(give)) { const max = r === 'fortune' ? p.fortune : p.res[r]; if (give[r] > max) give[r] = max; if (!give[r]) delete give[r]; }
}
function pickCard(r) {
  const st = S(), me = myPid(); if (!st || !isMyTurn() || st.phase !== 'main' || waiting) return;
  const p = st.players[me], max = r === 'fortune' ? p.fortune : p.res[r];
  if (r === 'fortune') give = give.fortune ? {} : { fortune: Math.min(3, max) }; // les jetons de Fortune s'échangent seuls, par 3
  else { delete give.fortune; give[r] = (give[r] || 0) + 1; if (give[r] > max) delete give[r]; } // au-delà de ce qu'on a, on repart de zéro
  delete want[r];
  renderHUD();
}
function bankDeal() {
  const st = S(), me = myPid();
  const g = Object.keys(give), w = Object.keys(want);
  if (g.length !== 1) return { ok: false, label: g.length ? 'une seule ressource' : 'taux 4:1 à 2:1' };
  const r = g[0], rate = r === 'fortune' ? 3 : rateFor(st, me, r);
  if (give[r] !== rate) return { ok: false, label: `il en faut ${rate}` };
  if (w.length !== 1 || want[w[0]] !== 1) return { ok: false, label: `${rate}:1 · voulez 1 carte` };
  if (st.bank[w[0]] < 1) return { ok: false, label: 'banque vide' };
  return { ok: true, label: `${rate} contre 1`, give: r, get: w[0] };
}
function renderTrade() {
  const st = S();
  const gk = Object.keys(give);
  $('tpGive').innerHTML = gk.length ? gk.map(r => `<button type="button" class="chip" data-r="${r}" aria-label="Retirer une carte">${icon(r)}<span class="k">${give[r]}</span></button>`).join('') : '<span class="none">Touchez vos cartes en bas</span>';
  $('tpGive').querySelectorAll('.chip').forEach(b => b.onclick = () => { const r = b.dataset.r; if (r === 'fortune' || !--give[r]) delete give[r]; renderHUD(); });
  $('tpWant').innerHTML = RES.map(r => `<button type="button" class="chip ${want[r] ? '' : 'zero'}" data-r="${r}" ${give[r] ? 'disabled' : ''} aria-label="${RES_INFO[r].nom}">${icon(r)}${want[r] ? `<span class="k">${want[r]}</span>` : ''}</button>`).join('') +
    (Object.keys(want).length ? '<button type="button" class="chip" id="wantClear" aria-label="Effacer">✕</button>' : '');
  $('tpWant').querySelectorAll('.chip[data-r]').forEach(b => b.onclick = () => { const r = b.dataset.r; want[r] = ((want[r] || 0) % 4) + 1; renderTrade(); });
  $('wantClear')?.addEventListener('click', () => { want = {}; renderTrade(); });
  $('btnPropose').disabled = !(Object.keys(give).length && !give.fortune && Object.keys(want).length);
  $('btnPropose').querySelector('small').textContent = st.players.length > 2 ? 'à tous' : 'proposer';
  const d = bankDeal();
  $('btnTrade').disabled = !d.ok; $('bankRate').textContent = d.label;
}
$('btnBank').onclick = () => { tradeOpen = !tradeOpen; buildOpen = false; uiMode = null; refreshAll(); };
$('btnPropose').onclick = () => { const a = { t: 'offer', give: { ...give }, want: { ...want } }; give = {}; want = {}; tradeOpen = false; act(a); };
$('btnTrade').onclick = () => { const d = bankDeal(); if (!d.ok) return; give = {}; want = {}; tradeOpen = false; act({ t: 'trade', give: d.give, get: d.get }); };
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
function goHome() { document.body.classList.add('home'); renderHome(); showOverlay('homeOverlay'); }

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
  const m = MODES[modeId];
  session.lobby = { code, hostId: ME.id, seats: [{ clientId: ME.id, name: ME.name }], mode: m.id, win: m.win, min: m.min, max: m.max, turnTime: timePref, map: mapId, size: sizeId };
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
  const cap = l.max || MAX_PLAYERS, min = l.min || 2;
  $('lobbyCode').textContent = l.code;
  $('lobbyMode').textContent = `${MODES[l.mode]?.nom || 'Partie'} · ${MAPS.find(x => x.id === l.map)?.nom || "L'Archipel"} · ${SIZES.find(x => x.id === l.size)?.nom || 'Normale'}`;
  $('lobbySeats').innerHTML = l.seats.map((s, i) => `<li><span class="dot" style="background:${PLAYER_DEFS[i].col}"></span><b>${esc(s.name)}</b>${s.clientId === l.hostId ? '<small>hôte</small>' : ''}${s.clientId === ME.id ? '<small>vous</small>' : ''}${session.peers.has(s.clientId) ? '' : '<small class="off">hors ligne</small>'}</li>`).join('') +
    Array.from({ length: Math.max(0, cap - l.seats.length) }, () => '<li class="free"><span class="dot"></span>Place libre</li>').join('');
  const host = session.isHost;
  $('btnLaunch').style.display = host ? '' : 'none';
  $('btnLaunch').disabled = l.seats.length < min;
  $('lobbyStatus').textContent = host ? (l.seats.length < min ? `Envoyez le code à vos amis : il faut au moins ${min} joueurs.` : `Prêt : ${l.seats.length} joueurs, carte ${MAPS.find(x => x.id === l.map)?.nom || "L'Archipel"} (${(SIZES.find(x => x.id === l.size)?.nom || 'Normale').toLowerCase()}), ${l.win} points pour gagner${l.seats.length > 4 ? ', sur la grande île' : ''}, temps par tour : ${TIME_LABEL(l.turnTime || 0)}.`) : "En attente que l'hôte lance la partie…";
}
$('btnInvite').onclick = () => session && shareInvite(session.code);
$('btnLobbyLeave').onclick = () => { leave(); goHome(); };
$('btnClaimWatch').onclick = () => { claimDismissed = S()?.gameId; $('claimOverlay').classList.remove('show'); };
$('btnLaunch').onclick = () => {
  const l = session.lobby; if (!session.isHost || l.seats.length < (l.min || 2)) return;
  const st = createGame({ seats: l.seats, win: l.win, code: l.code, hostId: ME.id, turnTime: l.turnTime || 0, map: l.map || 'classique', size: l.size || 'normale' });
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
    if (session.state) {
      // Même nom qu'un joueur déconnecté : on lui rend sa place au lieu d'en faire un spectateur
      const st = session.state, known = st.players.some(p => p.clientId === m.from);
      const same = !known && m.name && st.players.find(p => p.nom.trim().toLowerCase() === m.name.trim().toLowerCase() && !session.peers.has(p.clientId));
      if (same) { reassignSeat(same.id, m.from); return; }
      syncTimer(st); session.room.send({ type: 'state', state: st, events: [] }); return;
    }
    const l = session.lobby; if (!l) return;
    let seat = l.seats.find(s => s.clientId === m.from);
    // Dans le salon aussi : un joueur qui revient avec le même nom reprend sa place
    if (!seat && m.name) { seat = l.seats.find(s => s.name.trim().toLowerCase() === m.name.trim().toLowerCase() && !session.peers.has(s.clientId)); if (seat) seat.clientId = m.from; }
    if (seat) seat.name = m.name || seat.name;
    else if (l.seats.length < (l.max || MAX_PLAYERS)) l.seats.push({ clientId: m.from, name: m.name || PLAYER_DEFS[l.seats.length].nom });
    else { session.room.send({ type: 'error', to: m.from, msg: `La partie est complète (${l.max || MAX_PLAYERS} joueurs).` }); return; }
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
  if (m.type === 'claim' && session.isHost && session.state) {
    const st = session.state, q = st.players[m.pid];
    if (!q) return;
    if (q.clientId !== m.from && session.peers.has(q.clientId)) { session.room.send({ type: 'error', to: m.from, msg: `${q.nom} est encore connecté : choisissez une autre place.` }); return; }
    reassignSeat(m.pid, m.from); return;
  }
  if (m.type === 'error') { waiting = false; clearTimeout(waitTimer); toast(m.msg, 3500); refreshAll(); }
}

/* Rendre une place à un joueur qui revient (nouveau téléphone, appli réinstallée, autre navigateur) */
function reassignSeat(pid, clientId) {
  const st = session.state, q = st.players[pid];
  const old = st.players.findIndex(p => p.clientId === clientId);
  if (old >= 0 && old !== pid) st.players[old].clientId = null;
  q.clientId = clientId; st.seq++;
  const events = [{ k: 'toast', msg: `${q.nom} est de retour dans la partie` }];
  session.room.send({ type: 'state', state: st, events });
  onNewState(st, events, true);
}
/* Arrivé dans une partie en cours sans y avoir de place : on propose de reprendre celle d'un joueur */
let claimDismissed = null;
function renderClaim() {
  const st = S(), ov = $('claimOverlay');
  const need = session?.mode === 'online' && st && st.phase !== 'over' && myPid() < 0 && claimDismissed !== st.gameId;
  if (!need) { ov.classList.remove('show'); return; }
  const rows = st.players.map(q => {
    const on = session.peers.has(q.clientId);
    return `<button type="button" class="seat ${on ? 'on' : ''}" data-pid="${q.id}" ${on ? 'disabled' : ''}><span class="dot" style="background:${q.col}"></span><b>${esc(q.nom)}</b><small>${on ? 'connecté' : 'déconnecté · reprendre'}</small></button>`;
  }).join('');
  if ($('claimList').dataset.html === rows) { if (!ov.classList.contains('show')) ov.classList.add('show'); return; }
  $('claimList').innerHTML = rows; $('claimList').dataset.html = rows;
  $('claimList').querySelectorAll('.seat').forEach(b => b.onclick = () => { session.room.send({ type: 'claim', from: ME.id, pid: +b.dataset.pid }); toast('Reconnexion…'); });
  if (!ov.classList.contains('show')) { for (const o of document.querySelectorAll('.overlay')) o.classList.remove('show'); ov.classList.add('show'); }
}
function onPeers(ids) {
  if (!session) return;
  session.peers = new Set(ids);
  if (session.lobby) renderLobby();
  if (session.state) { renderHUD(); renderClaim(); }
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
  session = { mode: 'local', state: createGame({ seats, win: MODES[modeId].win, turnTime: timePref, map: mapId, size: sizeId }) };
  hideOverlays(); resetCamera(); onNewState(session.state, [], false);
  toast('La brume cache les terrains. Les numéros restent visibles.', 3600);
}

/* ---------- Écran d'accueil ---------- */
/* Modes de jeu : ils fixent les points de victoire et le nombre de places */
const MODES = {
  duel:       { id: 'duel',       nom: 'Duel',       min: 2, max: 2, win: 10, min_: 20, ico: 'bastion', tag: '' },
  escale:     { id: 'escale',     nom: 'Escale',     min: 2, max: 4, win: 7,  min_: 15, ico: 'sablier', tag: 'Rapide' },
  expedition: { id: 'expedition', nom: 'Expédition', min: 3, max: 4, win: 10, min_: 30, ico: 'camp',    tag: '' },
  grande:     { id: 'grande',     nom: 'Grande île', min: 5, max: 6, win: 10, min_: 40, ico: 'phare',   tag: '' },
};
/* Cartes : vignette dessinée à partir de la vraie forme de l'île */
let mapId = store.get(KEY + 'map', 'classique'), sizeId = store.get(KEY + 'size', 'normale');
if (!SIZES.some(x => x.id === sizeId)) sizeId = 'normale';
if (!MAPS.some(m => m.id === mapId)) mapId = 'classique';
const TERRAIN_TINT = { bois: '#3d7a46', pierre: '#c0683c', lin: '#98b957', grain: '#dfac45', cristal: '#7c879e', phare: '#ffcf6b' };
const thumbs = {};
function mapThumb(id) {
  if (thumbs[id]) return thumbs[id];
  const isl = generateIsland(id === 'sauvage' ? 7 : 20261111, false, id);
  const xs = isl.tiles.map(t => t.x), zs = isl.tiles.map(t => t.z);
  const minX = Math.min(...xs) - 1, maxX = Math.max(...xs) + 1, minZ = Math.min(...zs) - 1.1, maxZ = Math.max(...zs) + 1.1;
  const hex = (cx, cz) => Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 180 * (60 * i - 30); return `${(cx + 0.95 * Math.cos(a)).toFixed(2)},${(cz + 0.95 * Math.sin(a)).toFixed(2)}`; }).join(' ');
  const body = isl.tiles.map(t => `<polygon points="${hex(t.x, t.z)}" fill="${id === 'sauvage' && t.terrain !== 'phare' ? '#5d7482' : TERRAIN_TINT[t.terrain]}"/>`).join('');
  return (thumbs[id] = `<svg viewBox="${minX} ${minZ} ${maxX - minX} ${maxZ - minZ}" aria-hidden="true">${body}${id === 'sauvage' ? `<text x="${(minX + maxX) / 2}" y="${(minZ + maxZ) / 2 + 1.1}" text-anchor="middle" font-size="3.2" font-family="Fredoka" font-weight="600" fill="#fff">?</text>` : ''}</svg>`);
}
function renderMaps() {
  $('maps').innerHTML = MAPS.map(m => `<button type="button" class="mapCard ${m.id === mapId ? 'sel' : ''}" data-map="${m.id}">${mapThumb(m.id)}<b>${m.nom}</b><small>${m.desc}</small></button>`).join('');
  $('maps').querySelectorAll('.mapCard').forEach(b => b.onclick = () => { mapId = b.dataset.map; store.set(KEY + 'map', mapId); renderMaps(); });
  $('segSize').querySelectorAll('button').forEach(b => { b.classList.toggle('sel', b.dataset.v === sizeId); b.onclick = () => { sizeId = b.dataset.v; store.set(KEY + 'size', sizeId); renderMaps(); }; });
}
let homeTab = store.get(KEY + 'tab', 'online'), modeId = store.get(KEY + 'mode', 'expedition'), localN = 0, timePref = store.get(KEY + 'turnTime', 90);
if (!MODES[modeId]) modeId = 'expedition';
function requireName() {
  const n = $('nameInput').value.trim().slice(0, 12);
  if (!n) { toast('Choisissez un nom pour que vos amis vous reconnaissent'); $('nameInput').focus(); return false; }
  ME.name = n; store.set(KEY + 'name', n); return true;
}
function renderAvatar() { $('meAvatar').textContent = ($('nameInput').value.trim().charAt(0) || '?').toUpperCase(); }
function renderModes() {
  const m = MODES[modeId];
  $('modes').innerHTML = Object.values(MODES).map(x => `<button type="button" class="mode ${x.id === modeId ? 'sel' : ''}" data-m="${x.id}">
    <span class="pic">${icon(x.ico)}</span>
    <span><b>${x.nom}${x.tag ? `<span class="tag">${x.tag}</span>` : ''}</b>
      <span class="meta"><span>${icon('carte')}${x.min === x.max ? x.min : `${x.min}-${x.max}`} joueurs</span><span>${icon('fortune')}${x.win} pts</span><span>${icon('sablier')}~${x.min_} min</span></span></span></button>`).join('');
  $('modes').querySelectorAll('.mode').forEach(b => b.onclick = () => { modeId = b.dataset.m; store.set(KEY + 'mode', modeId); localN = 0; renderModes(); });
  // Sur ce téléphone : nombre de joueurs dans la plage du mode
  const local = homeTab === 'local';
  if (!localN || localN < m.min || localN > m.max) localN = Math.min(m.max, Math.max(m.min, 3));
  $('localCountField').hidden = !local || m.min === m.max;
  $('segLocal').innerHTML = Array.from({ length: m.max - m.min + 1 }, (_, i) => m.min + i).map(n => `<button type="button" data-v="${n}" class="${n === localN ? 'sel' : ''}">${n}</button>`).join('');
  $('segLocal').querySelectorAll('button').forEach(b => b.onclick = () => { localN = +b.dataset.v; renderModes(); });
  $('joinField').hidden = local;
  $('btnStart').textContent = local ? 'Démarrer la partie' : 'Créer la partie';
  $('tabOnline').classList.toggle('sel', !local); $('tabLocal').classList.toggle('sel', local);
  // Reprise de la partie en cours, selon l'onglet
  const last = store.get(KEY + 'last'), saved = store.get(KEY + 'local');
  const canResume = local ? !!(saved && saved.phase !== 'over') : !!(last && last.state && last.state.phase !== 'over' && last.state.players.some(p => p.clientId === ME.id));
  $('btnResume').hidden = !canResume;
  $('btnResume').textContent = local ? 'Reprendre la partie sur ce téléphone' : canResume ? `Reprendre la partie ${last.code}` : '';
}
function renderHome() {
  $('nameInput').value = ME.name || '';
  renderAvatar(); renderModes(); renderMaps();
  if (params.get('partie')) { homeTab = 'online'; renderModes(); $('codeInput').value = params.get('partie').toUpperCase().slice(0, 4); }
}
$('nameInput').addEventListener('input', renderAvatar);
$('nameInput').addEventListener('change', () => { const n = $('nameInput').value.trim().slice(0, 12); if (n) { ME.name = n; store.set(KEY + 'name', n); } });
$('tabOnline').onclick = () => { homeTab = 'online'; store.set(KEY + 'tab', homeTab); renderModes(); };
$('tabLocal').onclick = () => { homeTab = 'local'; store.set(KEY + 'tab', homeTab); renderModes(); };
$('segTime').querySelectorAll('button').forEach(b => {
  b.classList.toggle('sel', +b.dataset.v === timePref);
  b.onclick = () => { $('segTime').querySelectorAll('button').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); timePref = +b.dataset.v; store.set(KEY + 'turnTime', timePref); };
});
$('btnStart').onclick = () => {
  if (homeTab === 'local') { const n = $('nameInput').value.trim(); if (n) { ME.name = n.slice(0, 12); store.set(KEY + 'name', ME.name); } startLocal(MODES[modeId].min === MODES[modeId].max ? MODES[modeId].min : localN); }
  else createOnline();
};
$('btnJoin').onclick = () => joinOnline($('codeInput').value);
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinOnline($('codeInput').value); });
$('btnResume').onclick = () => {
  if (homeTab === 'local') { leave(); deadline = 0; timerKey = null; session = { mode: 'local', state: store.get(KEY + 'local') }; hideOverlays(); resetCamera(); onNewState(session.state, [], false); return; }
  const last = store.get(KEY + 'last'); if (!requireName()) return; joinOnline(last.code, last.state);
};
$('navRules').onclick = () => showOverlay('rulesOverlay');
$('btnRulesClose').onclick = () => session ? hideOverlays() : goHome();

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
