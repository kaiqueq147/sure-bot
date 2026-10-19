const BOOKS = {
  polymarket: { label: 'Polymarket', color: '#2d6cf6' },
  thunderpick: { label: 'Thunderpick', color: '#a855f7' },
  duel: { label: 'Duel', color: '#f97316' },
  simulator: { label: 'Simulador', color: '#64748b' },
};
const BOOK_LABEL = Object.fromEntries(Object.entries(BOOKS).map(([k, v]) => [k, v.label]));

const GAMES = {
  cs2: { label: 'CS2', color: '#f5c518' },
  dota2: { label: 'Dota 2', color: '#e0442f' },
  lol: { label: 'League of Legends', color: '#c89b3c' },
  valorant: { label: 'Valorant', color: '#ff4655' },
  r6: { label: 'Rainbow Six', color: '#3d8bfd' },
  overwatch: { label: 'Overwatch', color: '#fa9c1e' },
  sc2: { label: 'StarCraft II', color: '#00b4d8' },
  mlbb: { label: 'Mobile Legends', color: '#7b61ff' },
  hok: { label: 'Honor of Kings', color: '#e05297' },
  aov: { label: 'Arena of Valor', color: '#20c997' },
  rl: { label: 'Rocket League', color: '#4361ee' },
  cod: { label: 'Call of Duty', color: '#84cc16' },
  other: { label: 'eSports', color: '#8a96ad' },
};
const gameMeta = (g) => GAMES[g] ?? GAMES.other;

function gameBadge(el, game) {
  const meta = gameMeta(game);
  el.style.setProperty('--g', meta.color);
  el.style.setProperty('--icon', `url(/icons/${GAMES[game] ? game : 'other'}.svg)`);
  $('.glabel', el).textContent = meta.label;
}
const CLOSED_REASON = {
  odds_moved: 'Encerrada: odds mudaram',
  stale: 'Encerrada: odds desatualizadas',
  unmatched: 'Encerrada: evento saiu do mapeamento',
};
const CLOSED_TTL_MS = 12_000;

const $ = (sel, root = document) => root.querySelector(sel);
const fmtMoney = (v) => `$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtOdds = (v) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const uiIcon = (name) => `url(/icons/ui/${name}.svg)`;
const fmtAge = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}min` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
};
const STATE_ICON = { confirmed: 'circle-check', pending: 'loader', closed: 'circle-x' };

const state = {
  opps: new Map(), // id -> { opp, el, closed }
  bankroll: Number(localStorage.getItem('bankroll')) || 1000,
  minProfit: Number(localStorage.getItem('minProfit')) || 0,
  game: 'all',
  onlyConfirmed: false,
  tab: ['ev', 'hist'].includes(localStorage.getItem('tab')) ? localStorage.getItem('tab') : 'arb',
  taken: new Set(),
  ev: new Map(), // id -> { bet, el }
  minEv: Number(localStorage.getItem('minEv') || 0),
  minDiff: Number(localStorage.getItem('minDiff') ?? 0.3),
  onlyPrematch: false,
  sound: localStorage.getItem('sound') === '1',
};

// ------------------------------------------------------------------ cálculos

function splitStakes(bankroll, o1, o2) {
  const margin = 1 / o1 + 1 / o2;
  const s1 = (bankroll / o1) / margin;
  const s2 = (bankroll / o2) / margin;
  return { s1, s2, payout: bankroll / margin, profit: bankroll / margin - bankroll };
}

const applyCommission = (odds, pct) => (pct ? 1 + (odds - 1) * (1 - pct / 100) : odds);

/** Odd média ao apostar `usd` percorrendo o livro (Polymarket); casas sem livro usam a odd cotada. */
function legExec(leg, usd) {
  if (!leg.depth?.length || usd <= 0) {
    return { odds: leg.effectiveOdds, filled: leg.maxStake != null ? Math.min(usd, leg.maxStake) : usd };
  }
  const fee = leg.takerFeeRate ?? 0;
  let remaining = usd;
  let shares = 0;
  for (const [p, size] of leg.depth) {
    if (remaining <= 1e-9) break;
    const unit = p * (1 + fee * (1 - p));
    const take = Math.min(remaining, unit * size);
    shares += take / unit;
    remaining -= take;
  }
  const filled = usd - remaining;
  return { odds: filled > 0 ? applyCommission(shares / filled, leg.commissionPct ?? 0) : leg.effectiveOdds, filled };
}

/**
 * Divide a banca usando a odd executável de cada perna: a odd depende da stake e a stake
 * depende da odd, então algumas iterações bastam para convergir.
 */
function planArb(opp, bankroll) {
  const [a, b] = opp.legs;
  let oa = a.effectiveOdds;
  let ob = b.effectiveOdds;
  let short = false;
  for (let i = 0; i < 4; i++) {
    const { s1, s2 } = splitStakes(bankroll, oa, ob);
    const ea = legExec(a, s1);
    const eb = legExec(b, s2);
    oa = ea.odds;
    ob = eb.odds;
    short = ea.filled < s1 - 0.01 || eb.filled < s2 - 0.01;
  }
  const split = splitStakes(bankroll, oa, ob);
  return { ...split, oa, ob, short };
}

const MAX_SEARCH_BANKROLL = 100_000;
const viable = (opp, bankroll) => {
  const p = planArb(opp, bankroll);
  return !p.short && p.profit > 0;
};

/** Maior banca em que a arbitragem ainda dá lucro com a liquidez do livro (null = sem dados de livro). */
function maxBankroll(opp) {
  if (!opp.legs.some((l) => l.depth?.length || l.maxStake != null)) return null;
  if (viable(opp, MAX_SEARCH_BANKROLL)) return Infinity;
  let lo = 0;
  let hi = MAX_SEARCH_BANKROLL;
  if (!viable(opp, 1)) return 0;
  for (let i = 0; i < 30 && hi - lo > 1; i++) {
    const mid = (lo + hi) / 2;
    if (viable(opp, mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// ------------------------------------------------------------------ websocket

let ws;
let retry = 0;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  setConn('warn', 'Conectando…');

  ws.onopen = () => {
    retry = 0;
    setConn('ok', 'Dashboard ao vivo');
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => {
    const delay = Math.min(15_000, 500 * 2 ** retry++);
    setConn('bad', `Desconectado, reconectando em ${Math.round(delay / 1000)}s`);
    // Sem conexão as odds exibidas podem estar velhas: marca tudo como encerrado até o próximo snapshot.
    for (const [id] of state.opps) markClosed(id, 'stale');
    setTimeout(connect, delay);
  };
  ws.onerror = () => ws.close();
}

function setConn(kind, text) {
  const pill = $('#conn-pill');
  pill.className = `pill ${kind}`;
  pill.lastChild.textContent = text;
}

function handle(msg) {
  switch (msg.type) {
    case 'snapshot': {
      const ids = new Set(msg.opportunities.map((o) => o.id));
      for (const [id, entry] of state.opps) if (!ids.has(id)) removeCard(id, entry);
      state.taken = new Set(msg.taken ?? []);
      msg.opportunities.forEach(upsert);
      renderEv(msg.ev ?? [], { silent: true });
      renderSources(msg.sources, msg.pairs);
      renderHealth(msg.health);
      break;
    }
    case 'ev':
      renderEv(msg.items);
      break;
    case 'opportunity':
      upsert(msg.opportunity);
      break;
    case 'closed':
      markClosed(msg.id, msg.reason);
      break;
    case 'taken':
      markLocalTaken(msg.id);
      break;
    case 'taken-cleared':
      clearLocalTaken();
      break;
    case 'sources':
      renderSources(msg.sources, msg.pairs);
      renderHealth(msg.health);
      break;
  }
  updateEmpty();
}

// ------------------------------------------------------------------ status

function renderSources(sources, pairs) {
  const box = $('#status');
  box.querySelectorAll('.pill.src').forEach((p) => p.remove());
  for (const s of sources) {
    const kind = s.state === 'connected' ? 'ok' : s.state === 'connecting' || s.state === 'degraded' ? 'warn' : 'bad';
    const pill = document.createElement('span');
    pill.className = `pill src ${kind}`;
    pill.title = s.detail ?? '';
    pill.style.setProperty('--book', BOOKS[s.book]?.color ?? '#64748b');
    pill.innerHTML = '<i></i>';
    pill.append(`${BOOK_LABEL[s.book] ?? s.book} · ${s.quotes} mercados`);
    box.append(pill);
  }
  $('#meta').textContent = `${pairs ?? 0} eventos pareados · ${[...state.opps.values()].filter((e) => !e.closed).length} oportunidades`;
}

const STATE_LABEL = {
  connected: 'Conectada',
  connecting: 'Conectando',
  degraded: 'Degradada',
  disconnected: 'Desconectada',
  error: 'Erro',
  idle: 'Parada',
};

function row(cells) {
  const tr = document.createElement('tr');
  for (const c of cells) {
    const td = document.createElement('td');
    const [text, cls] = Array.isArray(c) ? c : [c];
    if (text instanceof Node) td.append(text);
    else td.textContent = text ?? '';
    if (cls) td.className = cls;
    tr.append(td);
  }
  return tr;
}

function renderHealth(list) {
  if (!list) return;
  const now = Date.now();
  let worst = 'ok';
  const rows = list.map((h) => {
    const kind = h.state === 'connected' ? 'ok' : h.state === 'connecting' || h.state === 'degraded' ? 'warn' : 'bad';
    const lastAge = h.lastMessageAt ? now - h.lastMessageAt : null;
    // Sem dado há mais de 30s com a fonte "conectada" também é sinal de problema.
    const stale = lastAge != null && lastAge > 30_000;
    if (kind === 'bad' || (stale && worst === 'ok')) worst = kind === 'bad' ? 'bad' : 'warn';
    else if (kind === 'warn' && worst === 'ok') worst = 'warn';
    const book = document.createElement('span');
    book.className = 'bk';
    book.style.setProperty('--book', BOOKS[h.book]?.color ?? '#8a96ad');
    book.textContent = BOOK_LABEL[h.book] ?? h.book;
    const st = document.createElement('span');
    st.className = `health-state ${kind}`;
    st.textContent = STATE_LABEL[h.state] ?? h.state;
    const lat = h.latencyMs == null ? '—' : h.latencyMs < 1000 ? `${Math.round(h.latencyMs)} ms` : `${(h.latencyMs / 1000).toFixed(1).replace('.', ',')} s`;
    return row([
      book,
      st,
      [String(h.quotes), 'num'],
      [String(h.updatesPerMin), 'num'],
      [lastAge == null ? '—' : `há ${fmtAge(lastAge)}`, `num${stale ? ' warn' : ''}`],
      [lat, `num${h.latencyMs > 3000 ? ' warn' : ''}`],
      [`${h.uptimePct.toFixed(1).replace('.', ',')}%`, `num${h.uptimePct < 95 ? ' warn' : ''}`],
      [h.disconnects ? `${h.disconnects} (última há ${fmtAge(now - h.lastDisconnectAt)})` : '0', 'num'],
      [h.detail ?? '', 'detail'],
    ]);
  });
  $('#health-panel tbody').replaceChildren(...rows);
  $('#health-btn').dataset.kind = worst;
}

// ------------------------------------------------------------------ histórico (relatório)

let reportTimer;
async function loadReport() {
  clearTimeout(reportTimer);
  if (state.tab !== 'hist') return;
  reportTimer = setTimeout(loadReport, 60_000);
  const hours = $('#hist-period').value;
  let data;
  try {
    const res = await fetch(`/api/report?hours=${hours}`);
    const text = await res.text();
    data = text ? JSON.parse(text) : { error: `servidor respondeu vazio (HTTP ${res.status})` };
    if (!res.ok && !data.error) data = { error: data.error ?? `HTTP ${res.status}` };
  } catch (err) {
    data = { error: `falha ao buscar o relatório: ${err}` };
  }
  $('#hist-empty').hidden = !data.error;
  $('#hist-body').hidden = !!data.error;
  if (data.error) return void ($('#hist-error').textContent = data.error);
  renderReport(data);
}

const fmtWhen = (t) => new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function groupTable(el, groups, labelOf, valueLabel = 'Lucro médio') {
  const head = document.createElement('tr');
  head.innerHTML = `<th></th><th class="num">Qtd.</th><th class="num">${valueLabel}</th><th class="num">Máx.</th>`;
  el.replaceChildren(
    head,
    ...(groups.length
      ? groups.map((g) => row([labelOf(g.key), [String(g.count), 'num'], [pct(g.avgProfit, 2), 'num money'], [pct(g.maxProfit, 2), 'num']]))
      : [row([['Nada no período', 'muted']])]),
  );
}

function renderReport(r) {
  $('#h-arb-count').textContent = r.count;
  $('#h-arb-total').textContent = r.count ? 'só as que você marcou' : 'nada marcado neste período';
  $('#h-arb-avg').textContent = r.count ? pct(r.avgProfitPct, 2) : '—';
  $('#h-arb-sum').textContent = r.count ? fmtMoney(r.totalProfit) : '—';
  $('#h-arb-bank').textContent = r.count ? fmtMoney(r.totalBankroll) : '—';

  groupTable($('#h-by-game'), r.byGame, (k) => gameMeta(k).label);
  groupTable($('#h-by-books'), r.byBooks, (k) => k.split('×').map((b) => BOOK_LABEL[b] ?? b).join(' × '));
  groupTable($('#h-by-market'), r.byMarket, (k) => k);

  const max = Math.max(1, ...r.byHour);
  $('#h-by-hour').replaceChildren(
    ...r.byHour.map((n, h) => {
      const bar = document.createElement('div');
      bar.className = 'hour-bar';
      bar.title = `${String(h).padStart(2, '0')}h: ${n}`;
      bar.style.setProperty('--h', `${(n / max) * 100}%`);
      const label = document.createElement('small');
      label.textContent = h % 3 === 0 ? String(h) : '';
      bar.append(document.createElement('i'), label);
      return bar;
    }),
  );

  const arbHead = document.createElement('tr');
  arbHead.innerHTML = '<th>Quando</th><th>Jogo</th><th>Mercado</th><th>Pernas</th><th class="num">Banca</th><th class="num">Lucro</th>';
  $('#h-arb-items').replaceChildren(
    arbHead,
    ...(r.items.length
      ? r.items.map((o) => {
          const legs = (o.legs ?? []).map((l) => `${BOOK_LABEL[l.book] ?? l.book}: ${l.selection} @ ${fmtOdds(l.odds)} · ${fmtMoney(l.stake)}`).join(' · ');
          return row([
            fmtWhen(o.takenAt),
            `${gameMeta(o.game).label} · ${o.eventName}`,
            o.marketLabel,
            legs,
            [fmtMoney(o.bankroll), 'num'],
            [`${pct(o.profitPct, 2)} · ${fmtMoney(o.profit)}`, 'num money'],
          ]);
        })
      : [row([['Nenhuma arbitragem marcada como feita neste período', 'muted']])]),
  );
}

// ------------------------------------------------------------------ cards

function upsert(opp) {
  let entry = state.opps.get(opp.id);
  const isNew = !entry;
  if (!entry) {
    entry = { opp, el: createCard(opp.id), closed: false };
    state.opps.set(opp.id, entry);
    $('#feed').append(entry.el);
  }
  const prev = entry.opp;
  const wasConfirmed = !isNew && prev.status === 'confirmed';
  entry.opp = opp;
  if (entry.closed) {
    clearTimeout(entry.removeTimer);
    entry.closed = false;
  }
  renderCard(entry, isNew ? null : prev);
  if (isNew) scheduleHistory();

  if (opp.status === 'confirmed' && !wasConfirmed && passesFilter(opp) && shouldAlert(opp.id)) alertUser(opp);
}

/** Uma oportunidade que pisca (some e volta) só alerta de novo depois de ALERT_REPEAT_MS. */
const ALERT_REPEAT_MS = 10 * 60_000;
const alertedAt = new Map();
function shouldAlert(id) {
  const now = Date.now();
  const last = alertedAt.get(id);
  if (last && now - last < ALERT_REPEAT_MS) return false;
  alertedAt.set(id, now);
  return true;
}

function renderMarketTag(el, item) {
  const tag = $('.market-tag', el);
  const derived = item.market && item.market.type !== 'winner';
  tag.classList.toggle('derived', !!derived);
  $('.market-text', tag).textContent = item.marketLabel ?? 'Vencedor da partida';
}

// ------------------------------------------------------------------ ordenação

const SORTS = {
  arb: [
    ['profit', 'Maior lucro'],
    ['start', 'Início do jogo'],
    ['liquidity', 'Maior liquidez'],
    ['recent', 'Mais recentes'],
  ],
  ev: [
    ['ev', 'Maior EV'],
    ['diff', 'Maior diferença de odd'],
    ['start', 'Início do jogo'],
    ['liquidity', 'Maior liquidez'],
    ['recent', 'Mais recentes'],
  ],
};
state.sort = {
  arb: localStorage.getItem('sort-arb') ?? 'profit',
  ev: localStorage.getItem('sort-ev') ?? 'ev',
};

const legLiquidity = (legs) => {
  const known = legs.map((l) => l.maxStake).filter((v) => v != null);
  return known.length ? Math.min(...known) : -1;
};

/** Valor de ordenação: maior primeiro. */
function sortValue(kind, item) {
  const mode = state.sort[kind];
  if (mode === 'start') return -(item.startTime ?? Number.MAX_SAFE_INTEGER);
  if (mode === 'recent') return item.firstSeen;
  if (kind === 'arb') return mode === 'liquidity' ? legLiquidity(item.legs) : item.profitPct;
  if (mode === 'liquidity') return item.books[0]?.maxStake ?? -1;
  return mode === 'diff' ? item.oddsDiff : item.evPct;
}

let sortQueued = false;
function scheduleSort() {
  if (sortQueued) return;
  sortQueued = true;
  requestAnimationFrame(() => {
    sortQueued = false;
    const order = (entries, kind, pick) =>
      entries
        .map((e) => [e, sortValue(kind, pick(e))])
        .sort((x, y) => y[1] - x[1])
        .forEach(([e], i) => (e.el.style.order = String(i)));
    order([...state.opps.values()], 'arb', (e) => e.opp);
    order([...state.ev.values()], 'ev', (e) => e.bet);
  });
}

function renderSortOptions() {
  const select = $('#sort');
  select.replaceChildren(
    ...SORTS[state.tab].map(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      return o;
    }),
  );
  select.value = state.sort[state.tab];
}

function createCard(id) {
  const el = $('#card-tpl').content.firstElementChild.cloneNode(true);
  el.dataset.id = id;
  $('.open-both', el).addEventListener('click', () => {
    const entry = state.opps.get(id);
    // Navegadores podem bloquear a segunda aba como pop-up; os botões individuais servem de alternativa.
    for (const leg of entry.opp.legs) window.open(leg.url, '_blank', 'noopener');
  });
  $('.take', el).addEventListener('click', () => takeOpportunity(id));
  return el;
}

function markLocalTaken(id) {
  state.taken.add(id);
  const entry = state.opps.get(id);
  if (entry) renderTake(entry.el, id);
}

function clearLocalTaken() {
  state.taken.clear();
  for (const entry of state.opps.values()) renderTake(entry.el, entry.opp.id);
  if (state.tab === 'hist') loadReport();
}

function renderTake(el, id) {
  const done = state.taken.has(id);
  el.classList.toggle('taken', done);
  const btn = $('.take', el);
  btn.disabled = done;
  $('.take-text', btn).textContent = done ? 'Feita' : 'Fiz esta';
}

async function takeOpportunity(id) {
  if (state.taken.has(id)) return;
  const entry = state.opps.get(id);
  if (!entry) return;
  const { opp } = entry;
  const plan = planArb(opp, state.bankroll);
  const btn = $('.take', entry.el);
  btn.disabled = true;
  try {
    const res = await fetch('/api/taken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        oppId: opp.id,
        game: opp.game,
        eventName: opp.eventName,
        marketLabel: opp.marketLabel,
        league: opp.league,
        startTime: opp.startTime,
        profitPct: state.bankroll > 0 ? (plan.profit / state.bankroll) * 100 : opp.profitPct,
        bankroll: state.bankroll,
        stakeA: plan.s1,
        stakeB: plan.s2,
        payout: plan.payout,
        profit: plan.profit,
        legs: opp.legs.map((leg, i) => ({
          book: leg.book,
          selection: leg.selection,
          odds: i === 0 ? plan.oa : plan.ob,
          effectiveOdds: i === 0 ? plan.oa : plan.ob,
          stake: i === 0 ? plan.s1 : plan.s2,
          url: leg.url,
        })),
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    markLocalTaken(id);
  } catch (err) {
    btn.disabled = false;
    $('.take-text', btn).textContent = 'Tentar de novo';
    console.warn('falha ao marcar arbitragem', err);
  }
}

function renderCard(entry, prev) {
  const { opp, el } = entry;
  el.classList.toggle('confirmed', opp.status === 'confirmed' && !entry.closed);
  el.classList.toggle('closed', entry.closed);
  scheduleSort();

  gameBadge($('.game', el), opp.game);
  renderMarketTag(el, opp);
  el.style.setProperty('--g', gameMeta(opp.game).color);
  const st = $('.state', el);
  const stKind = entry.closed ? 'closed' : opp.status;
  st.className = `state ${stKind}`;
  $('.ui', st).style.setProperty('--icon', uiIcon(STATE_ICON[stKind] ?? 'loader'));
  $('.state-text', st).textContent = entry.closed
    ? CLOSED_REASON[entry.reason] ?? 'Encerrada'
    : opp.status === 'confirmed' ? 'Confirmada' : 'Validando…';
  $('.profit-pct', el).textContent = `+${opp.profitPct.toFixed(2)}%`;
  $('.event', el).textContent = opp.eventName;
  const parts = [];
  if (opp.league) parts.push(opp.league);
  if (opp.startTime) parts.push(new Date(opp.startTime).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }));
  parts.push(`match ${(opp.matchScore * 100).toFixed(0)}%`);
  $('.sub', el).textContent = parts.join(' · ');

  let oddsChanged = false;
  opp.legs.forEach((leg, i) => {
    const box = el.querySelector(`.leg[data-i="${i}"]`);
    box.className = `leg ${leg.book}`;
    box.style.setProperty('--book', BOOKS[leg.book]?.color ?? '#3b82f6');
    $('.book', box).textContent = BOOK_LABEL[leg.book] ?? leg.book;
    const oddsBox = $('.odds-box', box);
    $('.odds', box).textContent = fmtOdds(leg.odds);
    $('.prob', box).textContent = `${(100 / leg.odds).toFixed(1).replace('.', ',').replace(/,0$/, '')}¢`;
    const before = prev?.legs[i]?.odds;
    if (before && before !== leg.odds) {
      oddsChanged = true;
      const dir = leg.odds > before ? 'up' : 'down';
      oddsBox.classList.remove('up', 'down');
      oddsBox.classList.add(dir);
      $('.trend', box).style.setProperty('--icon', uiIcon(`arrow-${dir}`));
    }
    $('.selection', box).textContent = leg.selection;
    const link = $('.open', box);
    link.href = leg.url;
    $('.open-text', link).textContent = `Abrir ${BOOK_LABEL[leg.book] ?? leg.book}`;
  });

  if (oddsChanged) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  const warnings = $('.warnings', el);
  warnings.replaceChildren(
    ...opp.warnings.map((w) => {
      const li = document.createElement('li');
      const icon = document.createElement('i');
      icon.className = 'ui';
      icon.style.setProperty('--icon', uiIcon('triangle-alert'));
      li.append(icon, w);
      return li;
    }),
  );

  renderCalc(entry);
  renderTake(el, opp.id);
  applyFilter(entry);
}

function renderCalc(entry) {
  const { opp, el } = entry;
  const bankroll = state.bankroll;
  $('.bank-value', el).textContent = fmtMoney(bankroll);
  const plan = planArb(opp, bankroll);
  [plan.s1, plan.s2].forEach((stake, i) => {
    const box = el.querySelector(`.leg[data-i="${i}"]`);
    const leg = opp.legs[i];
    const exec = i === 0 ? plan.oa : plan.ob;
    $('.stake', box).textContent = fmtMoney(stake);
    $('.leg-return', box).textContent = fmtMoney(stake * exec);
    const eff = [];
    if (Math.abs(leg.effectiveOdds - leg.odds) > 0.0005) eff.push(`Líquida de taxa: ${fmtOdds(leg.effectiveOdds)}`);
    if (leg.depth?.length && Math.abs(exec - leg.effectiveOdds) > 0.0005) eff.push(`Com a banca: ${fmtOdds(exec)}`);
    $('.eff', box).textContent = eff.join(' · ');
    const liq = $('.liq', box);
    if (leg.maxStake != null) {
      const low = stake > leg.maxStake;
      liq.className = `liq${low ? ' low' : ''}`;
      $('.liq-text', liq).textContent = low
        ? `Liquidez insuficiente: ${fmtMoney(leg.maxStake)} no livro`
        : `Liquidez no livro: ${fmtMoney(leg.maxStake)}`;
    } else {
      liq.className = 'liq empty';
      $('.liq-text', liq).textContent = '';
    }
  });
  $('.payout', el).textContent = fmtMoney(plan.payout);
  const gain = $('.gain-value', el);
  gain.textContent = `${plan.profit >= 0 ? '+' : '−'}${fmtMoney(Math.abs(plan.profit))}`;
  gain.classList.toggle('negative', plan.profit < 0);

  const max = maxBankroll(opp);
  const note = $('.exec-note', el);
  note.hidden = max === null;
  if (max !== null) {
    const ok = !plan.short && plan.profit > 0;
    note.classList.toggle('bad', !ok);
    const pctReal = bankroll > 0 ? (plan.profit / bankroll) * 100 : 0;
    $('.exec-text', note).textContent =
      max === Infinity
        ? `Lucro pelo livro: ${pct(pctReal, 2)} · liquidez sobra para bancas acima de ${fmtMoney(MAX_SEARCH_BANKROLL)}`
        : max <= 0
          ? 'O livro não sustenta essa arbitragem nem com $ 1'
          : ok
            ? `Lucro pelo livro: ${pct(pctReal, 2)} · vale até ${fmtMoney(max)} de banca`
            : `Com essa banca o livro não sustenta a arbitragem: vale até ${fmtMoney(max)}`;
  }
}

function markClosed(id, reason) {
  const entry = state.opps.get(id);
  if (!entry || entry.closed) return;
  entry.closed = true;
  entry.reason = reason;
  renderCard(entry, entry.opp);
  entry.removeTimer = setTimeout(() => removeCard(id, entry), CLOSED_TTL_MS);
  updateEmpty();
}

function removeCard(id, entry) {
  clearTimeout(entry.removeTimer);
  entry.el.remove();
  state.opps.delete(id);
  updateEmpty();
}

// ------------------------------------------------------------------ EV+

const pct = (v, digits = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(digits).replace('.', ',')}%`;
const cents = (odds) => `${(100 / odds).toFixed(1).replace('.', ',').replace(/,0$/, '')}¢`;

function renderEv(items, { silent = false } = {}) {
  const ids = new Set(items.map((b) => b.id));
  for (const [id, entry] of state.ev) {
    if (ids.has(id)) continue;
    entry.el.remove();
    state.ev.delete(id);
  }
  for (const bet of items) {
    let entry = state.ev.get(bet.id);
    const isNew = !entry;
    if (!entry) {
      entry = { bet, el: $('#ev-tpl').content.firstElementChild.cloneNode(true) };
      state.ev.set(bet.id, entry);
      $('#ev-feed').append(entry.el);
    }
    const prev = entry.bet;
    entry.bet = bet;
    renderEvCard(entry, isNew ? null : prev);
    if (isNew) scheduleHistory();
    if (isNew && !silent && passesEvFilter(bet) && shouldAlert(bet.id)) alertEv(bet);
  }
  updateEmpty();
}

function renderEvCard(entry, prev) {
  const { bet, el } = entry;
  scheduleSort();
  el.style.setProperty('--g', gameMeta(bet.game).color);
  gameBadge($('.game', el), bet.game);
  renderMarketTag(el, bet);

  const when = $('.when', el);
  when.className = `when${bet.live ? ' live' : ''}`;
  $('.ui', when).style.setProperty('--icon', uiIcon(bet.live ? 'radio' : 'calendar-clock'));
  $('.when-text', when).textContent = bet.live ? 'Ao vivo' : 'Pré-jogo';

  $('.ev-pct', el).textContent = pct(bet.evPct);
  $('.event', el).textContent = bet.eventName;
  const parts = [];
  if (bet.league) parts.push(bet.league);
  if (bet.startTime) parts.push(new Date(bet.startTime).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }));
  $('.sub', el).textContent = parts.join(' · ');

  const best = bet.books[0];
  $('.ev-selection', el).textContent = bet.selection;
  $('.ev-vs', el).textContent = `contra ${bet.opponent}`;
  const bestBox = $('.ev-best', el);
  bestBox.style.setProperty('--book', BOOKS[best.book]?.color);
  $('.odds-label', bestBox).textContent = BOOK_LABEL[best.book];
  $('.odds', bestBox).textContent = fmtOdds(best.odds);
  $('.prob', bestBox).textContent = cents(best.odds);
  const before = prev?.books.find((b) => b.book === best.book)?.odds;
  bestBox.classList.remove('up', 'down');
  if (before && before !== best.odds) bestBox.classList.add(best.odds > before ? 'up' : 'down');

  const worst = bet.books[bet.books.length - 1];
  $('tbody', el).replaceChildren(
    ...bet.books.map((b) => {
      const tr = document.createElement('tr');
      tr.style.setProperty('--book', BOOKS[b.book]?.color);
      if (b === best) tr.className = 'best';
      else if (b === worst) tr.className = 'worst';
      if (b !== best && !b.inConsensus) tr.classList.add('excluded');
      const move = b.openingOdds ? (b.odds / b.openingOdds - 1) * 100 : 0;
      const moveCls = Math.abs(move) < 0.05 ? 'flat' : move > 0 ? 'up' : 'down';
      tr.innerHTML = `
        <td><span class="book-dot"></span><span class="bk"></span><span class="tag"></span></td>
        <td class="num odd"></td>
        <td class="num muted"></td>
        <td class="num muted"></td>
        <td class="num opening ${moveCls}"></td>
        <td><a class="row-link" target="_blank" rel="noopener noreferrer" title="Abrir"><i class="ui" style="--icon: ${uiIcon('external-link')}"></i></a></td>`;
      const cells = tr.children;
      $('.bk', cells[0]).textContent = BOOK_LABEL[b.book];
      $('.tag', cells[0]).textContent =
        b === best ? 'maior' : !b.inConsensus ? 'margem alta' : b === worst ? 'menor' : '';
      cells[1].textContent = fmtOdds(b.odds);
      cells[2].textContent = cents(b.odds);
      if (b.maxStake != null) cells[1].title = `Liquidez no melhor preço: ${fmtMoney(b.maxStake)}`;
      cells[3].textContent = `${b.overroundPct.toFixed(1).replace('.', ',')}%`;
      if (!b.inConsensus) cells[3].title = 'Margem alta: fora do cálculo da odd justa';
      cells[4].textContent = b.openingOdds
        ? `${fmtOdds(b.openingOdds)}${moveCls === 'flat' ? '' : ` ${moveCls === 'up' ? '▲' : '▼'} ${pct(move)}`}`
        : '—';
      $('.row-link', tr).href = b.url;
      return tr;
    }),
  );

  $('.fair-odds', el).textContent = `${fmtOdds(bet.fairOdds)} · ${cents(bet.fairOdds)}`;
  $('.disparity', el).textContent = `+${fmtOdds(bet.oddsDiff)} (${pct(bet.disparityPct)})`;
  $('.ev-money', el).textContent = `+${fmtMoney(bet.evPct)}`;

  $('.warnings', el).replaceChildren(
    ...bet.warnings.map((w) => {
      const li = document.createElement('li');
      const icon = document.createElement('i');
      icon.className = 'ui';
      icon.style.setProperty('--icon', uiIcon('triangle-alert'));
      li.append(icon, w);
      return li;
    }),
  );

  const link = $('.open-best', el);
  link.href = best.url;
  $('span', link).textContent = `Apostar na ${BOOK_LABEL[best.book]}`;
  $('.age-text', el).textContent = '';
  el.hidden = !passesEvFilter(bet);
}

function passesEvFilter(bet) {
  return (
    bet.evPct >= state.minEv &&
    bet.oddsDiff >= state.minDiff - 1e-9 &&
    (state.game === 'all' || bet.game === state.game) &&
    (!state.onlyPrematch || !bet.live)
  );
}

function alertEv(bet) {
  if (state.sound) beep();
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    const best = bet.books[0];
    new Notification(`EV ${pct(bet.evPct)} · ${bet.selection}`, {
      body: `${BOOK_LABEL[best.book]} @ ${fmtOdds(best.odds)} · odd justa ${fmtOdds(bet.fairOdds)}\n${bet.eventName}`,
      tag: bet.id,
    });
  }
}

function setTab(tab) {
  state.tab = tab;
  localStorage.setItem('tab', tab);
  document.body.dataset.tab = tab;
  $('#tab-arb').hidden = tab !== 'arb';
  $('#tab-ev').hidden = tab !== 'ev';
  $('#tab-hist').hidden = tab !== 'hist';
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  chipsSig = '';
  if (tab === 'hist') return void loadReport();
  renderSortOptions();
  updateEmpty();
  scheduleHistory();
}

// ------------------------------------------------------------------ filtros

let chipsSig = '';
function renderChips() {
  const counts = {};
  if (state.tab === 'ev') {
    for (const e of state.ev.values()) if (passesEvFilter({ ...e.bet, game: state.game === 'all' ? e.bet.game : state.game })) counts[e.bet.game] = (counts[e.bet.game] ?? 0) + 1;
  } else {
    for (const e of state.opps.values()) if (!e.closed) counts[e.opp.game] = (counts[e.opp.game] ?? 0) + 1;
  }
  const sig = `${state.game}|${JSON.stringify(counts)}`;
  if (sig === chipsSig) return;
  chipsSig = sig;
  const box = $('#game-chips');
  const chips = [['all', { label: 'Todas', color: '#e6ebf5' }], ...Object.entries(GAMES)];
  box.replaceChildren(
    ...chips.map(([id, meta]) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip${state.game === id ? ' active' : ''}${id !== 'all' && !counts[id] ? ' idle' : ''}`;
      chip.dataset.game = id;
      chip.style.setProperty('--g', meta.color);
      if (id !== 'all') {
        chip.style.setProperty('--icon', `url(/icons/${id}.svg)`);
        chip.innerHTML = '<i class="gicon"></i>';
      }
      chip.append(meta.label);
      const n = id === 'all' ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[id];
      if (n) {
        const badge = document.createElement('span');
        badge.className = 'count';
        badge.textContent = n;
        chip.append(badge);
      }
      return chip;
    }),
  );
}

function passesFilter(opp) {
  return (
    opp.profitPct >= state.minProfit &&
    (state.game === 'all' || opp.game === state.game) &&
    (!state.onlyConfirmed || opp.status === 'confirmed')
  );
}

function applyFilter(entry) {
  entry.el.hidden = !passesFilter(entry.opp);
}

function updateEmpty() {
  const arbVisible = [...state.opps.values()].filter((e) => !e.el.hidden).length;
  const evVisible = [...state.ev.values()].filter((e) => !e.el.hidden).length;
  $('#empty').hidden = arbVisible > 0;
  $('#ev-empty').hidden = evVisible > 0;
  $('#arb-count').textContent = arbVisible;
  $('#ev-count').textContent = evVisible;
  renderChips();
}

function refreshAll() {
  for (const entry of state.opps.values()) {
    applyFilter(entry);
    renderCalc(entry);
  }
  for (const entry of state.ev.values()) entry.el.hidden = !passesEvFilter(entry.bet);
  updateEmpty();
}

// ------------------------------------------------------------------ histórico de odds

const history = new Map(); // chave do quote -> [[t, oddA, oddB], ...]
const HISTORY_POLL_MS = 15_000;
let historyTimer;

function scheduleHistory(delay = 400) {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(refreshHistory, delay);
}

async function refreshHistory() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(refreshHistory, HISTORY_POLL_MS);
  if (document.hidden || state.tab === 'hist' || document.body.classList.contains('compact')) return;
  const entries = state.tab === 'ev' ? [...state.ev.values()] : [...state.opps.values()];
  const visible = entries.filter((e) => !e.el.hidden);
  const keys = new Set();
  for (const e of visible) {
    for (const x of e.opp ? e.opp.legs : e.bet.books) if (x.key) keys.add(x.key);
  }
  if (!keys.size) return;
  const list = [...keys];
  try {
    for (let i = 0; i < list.length; i += 100) {
      const res = await fetch(`/api/history?keys=${encodeURIComponent(list.slice(i, i + 100).join(','))}`);
      for (const [k, v] of Object.entries(await res.json())) history.set(k, v);
    }
  } catch {
    return;
  }
  for (const e of visible) (e.opp ? drawArbChart : drawEvChart)(e);
}

/** Odd vigente de um lado do quote no instante `t` (série em degraus). */
function oddsAt(samples, side, t) {
  let v = null;
  for (const s of samples) {
    if (s[0] > t) break;
    v = side === 'B' ? s[2] : s[1];
  }
  return v;
}

const CHART_W = 300;
const CHART_H = 70;

function chartScale(t0, t1, values) {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.15, 0.005);
  lo -= pad;
  hi += pad;
  return {
    x: (t) => ((t - t0) / Math.max(1, t1 - t0)) * CHART_W,
    y: (v) => CHART_H - ((v - lo) / (hi - lo)) * CHART_H,
  };
}

function stepPath(points, sc) {
  let d = '';
  let pen = false;
  for (const [t, v] of points) {
    if (v == null) {
      pen = false;
      continue;
    }
    const X = sc.x(t).toFixed(1);
    const Y = sc.y(v).toFixed(1);
    d += pen ? `H${X}V${Y}` : `M${X} ${Y}`;
    pen = true;
  }
  return d;
}

function chartEmpty(el, text) {
  $('.spark', el).innerHTML = '';
  $('.chart-legend', el).textContent = text;
}

const fmtPct = (v) => `${(v * 100).toFixed(1).replace('.', ',')}%`;

function drawArbChart(entry) {
  const { opp, el } = entry;
  const [a, b] = opp.legs;
  const sa = history.get(a.key) ?? [];
  const sb = history.get(b.key) ?? [];
  const now = Date.now();
  const times = [...new Set([...sa, ...sb].map((s) => s[0]))].sort((x, y) => x - y);
  const points = times.map((t) => {
    const oa = oddsAt(sa, a.side, t);
    const ob = oddsAt(sb, b.side, t);
    return [t, oa && ob ? 1 / oa + 1 / ob : null];
  });
  const vals = points.map((p) => p[1]).filter((v) => v != null);
  if (!vals.length) return chartEmpty(el, 'coletando histórico…');
  points.push([now, points[points.length - 1][1]]);
  const sc = chartScale(times[0], now, [...vals, 1]);
  const y100 = sc.y(1).toFixed(1);
  $('.spark', el).innerHTML = `
    <rect x="0" y="${y100}" width="${CHART_W}" height="${Math.max(0, CHART_H - y100)}" class="arb-zone" />
    <line x1="0" x2="${CHART_W}" y1="${y100}" y2="${y100}" class="ref" vector-effect="non-scaling-stroke" />
    <path d="${stepPath(points, sc)}" class="line money-line" vector-effect="non-scaling-stroke" />`;
  $('.chart-legend', el).textContent =
    `agora ${fmtPct(vals[vals.length - 1])} · mín ${fmtPct(Math.min(...vals))} · desde ${fmtAge(now - times[0])}`;
}

function drawEvChart(entry) {
  const { bet, el } = entry;
  const now = Date.now();
  const series = bet.books.map((b) => {
    const s = history.get(b.key) ?? [];
    return { b, points: s.map((x) => [x[0], b.side === 'B' ? x[2] : x[1]]) };
  });
  const vals = series.flatMap((s) => s.points.map((p) => p[1])).filter((v) => v != null);
  const t0 = Math.min(...series.flatMap((s) => s.points.map((p) => p[0])));
  if (!vals.length || !Number.isFinite(t0)) return chartEmpty(el, 'coletando histórico…');
  const sc = chartScale(t0, now, vals);
  $('.spark', el).innerHTML = series
    .filter((s) => s.points.length)
    .map((s) => {
      const pts = [...s.points, [now, s.points[s.points.length - 1][1]]];
      return `<path d="${stepPath(pts, sc)}" class="line" style="stroke:${BOOKS[s.b.book]?.color ?? '#8a96ad'}" vector-effect="non-scaling-stroke" />`;
    })
    .join('');
  $('.chart-legend', el).textContent = `${fmtOdds(Math.min(...vals))} – ${fmtOdds(Math.max(...vals))} · desde ${fmtAge(now - t0)}`;
}

// ------------------------------------------------------------------ alertas

function alertUser(opp) {
  if (state.sound) beep();
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    const [a, b] = opp.legs;
    new Notification(`+${opp.profitPct.toFixed(2)}% · ${opp.eventName}`, {
      body: `${BOOK_LABEL[a.book]}: ${a.selection} @ ${a.odds.toFixed(2)}\n${BOOK_LABEL[b.book]}: ${b.selection} @ ${b.odds.toFixed(2)}`,
      tag: opp.id,
    });
  }
}

let audioCtx;
function beep() {
  audioCtx ??= new AudioContext();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.25);
}

// ------------------------------------------------------------------ controles

function initControls() {
  const bankroll = $('#bankroll');
  bankroll.value = state.bankroll;
  bankroll.addEventListener('input', () => {
    state.bankroll = Number(bankroll.value) || 0;
    localStorage.setItem('bankroll', String(state.bankroll));
    refreshAll();
  });

  const minProfit = $('#min-profit');
  minProfit.value = state.minProfit;
  minProfit.addEventListener('input', () => {
    state.minProfit = Number(minProfit.value) || 0;
    localStorage.setItem('minProfit', String(state.minProfit));
    refreshAll();
  });

  $('#game-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.game = chip.dataset.game === state.game ? 'all' : chip.dataset.game;
    renderChips();
    refreshAll();
  });
  renderChips();
  $('#only-confirmed').addEventListener('change', (e) => {
    state.onlyConfirmed = e.target.checked;
    refreshAll();
  });

  const minEv = $('#min-ev');
  minEv.value = state.minEv;
  minEv.addEventListener('input', () => {
    state.minEv = Number(minEv.value) || 0;
    localStorage.setItem('minEv', String(state.minEv));
    chipsSig = '';
    refreshAll();
  });
  const minDiff = $('#min-diff');
  minDiff.value = state.minDiff;
  minDiff.addEventListener('input', () => {
    state.minDiff = Number(minDiff.value) || 0;
    localStorage.setItem('minDiff', String(state.minDiff));
    chipsSig = '';
    refreshAll();
  });
  $('#only-prematch').addEventListener('change', (e) => {
    state.onlyPrematch = e.target.checked;
    refreshAll();
  });
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) setTab(tab.dataset.tab);
  });
  $('#hist-period').value = localStorage.getItem('hist-period') ?? '24';
  $('#hist-period').addEventListener('change', (e) => {
    localStorage.setItem('hist-period', e.target.value);
    loadReport();
  });
  $('#clear-db').addEventListener('click', async () => {
    if (!confirm('Apagar todas as arbitragens que você marcou? Isso não tem volta.')) return;
    const btn = $('#clear-db');
    btn.disabled = true;
    try {
      const res = await fetch('/api/clear', { method: 'POST' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      clearLocalTaken();
    } catch (err) {
      alert(`Não deu para limpar: ${err.message ?? err}`);
    } finally {
      btn.disabled = false;
    }
  });
  $('#health-btn').addEventListener('click', () => {
    const panel = $('#health-panel');
    panel.hidden = !panel.hidden;
    $('#health-btn').setAttribute('aria-expanded', String(!panel.hidden));
  });
  $('#sort').addEventListener('change', (e) => {
    if (!SORTS[state.tab]) return;
    state.sort[state.tab] = e.target.value;
    localStorage.setItem(`sort-${state.tab}`, e.target.value);
    scheduleSort();
  });
  setTab(state.tab);

  const compact = $('#compact');
  compact.checked = localStorage.getItem('compact') === '1';
  document.body.classList.toggle('compact', compact.checked);
  compact.addEventListener('change', () => {
    document.body.classList.toggle('compact', compact.checked);
    localStorage.setItem('compact', compact.checked ? '1' : '0');
    if (!compact.checked) scheduleHistory();
  });

  const sound = $('#sound');
  sound.checked = state.sound;
  sound.addEventListener('change', () => {
    state.sound = sound.checked;
    localStorage.setItem('sound', state.sound ? '1' : '0');
    if (state.sound) beep();
  });

  const notifyBtn = $('#notify-btn');
  if (!('Notification' in window)) notifyBtn.hidden = true;
  else if (Notification.permission === 'granted') $('span', notifyBtn).textContent = 'Notificações ativas';
  notifyBtn.addEventListener('click', async () => {
    const perm = await Notification.requestPermission();
    $('span', notifyBtn).textContent = perm === 'granted' ? 'Notificações ativas' : 'Notificações bloqueadas';
  });

  setInterval(() => {
    const now = Date.now();
    for (const entry of state.opps.values()) {
      const secs = Math.round((now - entry.opp.firstSeen) / 1000);
      $('.age-text', entry.el).textContent = `aberta há ${secs}s`;
    }
    for (const entry of state.ev.values()) {
      $('.age-text', entry.el).textContent = `há ${fmtAge(now - entry.bet.firstSeen)}`;
    }
  }, 1000);
}

initControls();
connect();
