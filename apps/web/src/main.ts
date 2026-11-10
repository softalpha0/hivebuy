import './style.css';
import { bondShares, clear, explainClear, formatNear, formatUsdc, headline } from '@hivebuy/core';
import { runSimulation } from '@hivebuy/sim';
import { type ViewRound, fromSimulation } from './model.js';
import { loadTestnetRounds } from './testnet.js';

const STAGES = ['Join', 'Commit', 'Reveal', 'Clear'] as const;
const STAGE_BY_PHASE: Record<ViewRound['phase'], number> = {
  join: 0,
  commit: 1,
  reveal: 2,
  clearable: 2,
  cleared: 3,
  failed: 3,
};
const SVG = 'http://www.w3.org/2000/svg';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let rounds: ViewRound[] = [];
let selected = 0;
let stage = 3;
let replayTimer: number | undefined;
/** Live view: the contract being watched and the next refresh. */
let liveContract = '';
let liveTimer: number | undefined;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const short = (id: string | null) => (id ? esc(id.split('.')[0] ?? id) : '—');
const usd = (a: bigint | null) => (a === null ? '—' : formatUsdc(a));
const num = (a: bigint) => Number(a) / 1e6;
/** The clearing rule's inputs for a round, as the contract sees them. */
const roundInputs = (r: ViewRound) => ({
  buyers: r.buyers.map((b) => ({ id: b.id, qty: b.qty, maxPrice: b.maxPrice })),
  bids: r.sellers.filter((s) => s.revealed).map((s) => ({ id: s.id, price: s.revealed!.price, capacity: s.revealed!.capacity, commitIndex: s.commitIndex })),
});

/**
 * Re-runs the clearing rule in the browser on the round's on-chain bids and compares every
 * number with what the contract recorded. Returns the checks that failed (empty = verified).
 */
function verify(r: ViewRound): string[] {
  const res = r.result;
  if (!res) return ['not cleared yet'];
  const { buyers, bids } = roundInputs(r);
  const mine = clear(buyers, bids);
  const bad: string[] = [];
  if ((mine.price ?? null) !== res.price) bad.push('price');
  if (mine.demand !== res.demand) bad.push('units');
  const fills = (f: { id: string; units: number; payout: bigint }[]) => f.map((x) => `${x.id}:${x.units}:${x.payout}`).join();
  if (fills(mine.fills) !== fills(res.fills)) bad.push('fills');
  const settle = (st: { id: string; included: boolean; pay: bigint; refund: bigint }[]) => st.map((x) => `${x.id}:${x.included}:${x.pay}:${x.refund}`).join();
  if (settle(mine.settlements) !== settle(res.settlements)) bad.push('payments');
  const paidIn = res.settlements.reduce((a, x) => a + x.pay, 0n);
  if (paidIn !== res.fills.reduce((a, f) => a + f.payout, 0n)) bad.push('buyers paid ≠ providers earned');
  if (r.bondShares && r.bond !== undefined) {
    // Unrevealed bonds, split by units locked: the same function the contract runs.
    const forfeited = r.bond * BigInt(r.sellers.filter((x) => !x.revealed).length);
    const { shares } = bondShares(r.buyers.map((b) => b.qty), forfeited);
    const want = r.buyers.flatMap((b, i) => (shares[i]! > 0n ? [`${b.id}:${shares[i]}`] : [])).join();
    if (want !== r.bondShares.map((b) => `${b.id}:${b.amount}`).join()) bad.push('bond shares');
  }
  return bad;
}
const plain = (id: string) => id.split('.')[0] ?? id;
/** "seller-1", "seller-4 + seller-1" or "3 providers". Plain text; escape before using as HTML. */
const soldBy = (res: ViewRound['result']) =>
  !res?.fills.length ? '' : res.fills.length <= 2 ? res.fills.map((f) => plain(f.id)).join(' + ') : `${res.fills.length} providers`;

// ---------- data ----------

function runSim() {
  const seed = Math.max(1, Number($<HTMLInputElement>('seed').value) || 42);
  const count = Math.min(50, Math.max(1, Number($<HTMLInputElement>('rounds').value) || 10));
  rounds = fromSimulation(runSimulation({ seed, rounds: count }));
  select(0, true);
}

/** Buttons in the landing sections: jump to a live testnet round (or the latest one). */
async function gotoRound(target: string) {
  setTab(true);
  await loadNet();
  const i = target === 'latest' ? rounds.length - 1 : rounds.findIndex((r) => r.id === Number(target) && r.source === 'testnet');
  if (i >= 0) select(i, false);
  $('detail').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
}

async function loadNet() {
  const contract = $<HTMLInputElement>('contract').value.trim();
  const status = $('net-status');
  if (!contract) {
    status.textContent = 'Enter the coordinator contract account, for example market.hivebuy.testnet.';
    return;
  }
  status.textContent = 'Loading rounds from NEAR testnet…';
  document.body.classList.add('loading');
  try {
    const loaded = await loadTestnetRounds(contract);
    if (loaded.length === 0) {
      status.textContent = 'No rounds on this contract yet. Open one with the testnet script.';
      return;
    }
    rounds = loaded;
    liveContract = contract;
    lastSignature = signature(loaded);
    netStatus();
    select(rounds.length - 1, false);
    scheduleLive();
  } catch (e) {
    status.textContent = `Could not read ${contract}: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    document.body.classList.remove('loading');
  }
}

// ---------- live view ----------

const isOpen = (r: ViewRound) => r.phase !== 'cleared' && r.phase !== 'failed';
/** Running now: open, and not a round abandoned long ago without anyone calling clear(). */
const isLive = (r: ViewRound) => isOpen(r) && !!r.ends && (r.phase !== 'clearable' || Date.now() - r.ends.reveal < 10 * 60_000);
const netActive = () => $('tab-net').getAttribute('aria-selected') === 'true';
/** Changes whenever anything visible changes: a join, a commit, a reveal, a phase, a result. */
const signature = (list: ViewRound[]) =>
  list
    .map((r) => `${r.id}:${r.phase}:${r.buyers.length}:${r.sellers.length}:${r.sellers.filter((x) => x.revealed).length}:${r.result?.price ?? ''}:${r.notes ? 1 : 0}`)
    .join('|');
let lastSignature = '';

function netStatus() {
  const live = [...rounds].reverse().find(isLive);
  $('net-status').textContent = live
    ? `Round ${live.id} is running on NEAR testnet right now. This page updates by itself.`
    : `${rounds.length} round${rounds.length === 1 ? '' : 's'} from ${liveContract} on NEAR testnet. New rounds appear here by themselves.`;
}

/** Re-reads the contract every 3 s while a round runs, every 15 s otherwise (only while the tab is open). */
function scheduleLive() {
  window.clearTimeout(liveTimer);
  if (!netActive() || !liveContract) return;
  liveTimer = window.setTimeout(() => void refreshLive(), rounds.some(isLive) ? 3_000 : 15_000);
}

async function refreshLive() {
  if (!netActive() || document.hidden) return scheduleLive();
  const contract = liveContract;
  try {
    const loaded = await loadTestnetRounds(contract);
    if (!netActive() || contract !== liveContract || !loaded.length) return;
    const sig = signature(loaded);
    if (sig !== lastSignature) {
      const current = rounds[selected];
      const followLatest = selected === rounds.length - 1;
      rounds = loaded;
      lastSignature = sig;
      const i = followLatest ? rounds.length - 1 : rounds.findIndex((r) => r.id === current?.id);
      netStatus();
      select(i >= 0 ? i : rounds.length - 1, false);
    }
  } catch {
    // Keep showing the last good data; the next refresh tries again.
  } finally {
    scheduleLive();
  }
}

function countdownText(r: ViewRound): string {
  const e = r.ends!;
  const now = Date.now();
  const [label, end] = now < e.join ? ['join phase', e.join] : now < e.commit ? ['commit phase', e.commit] : now < e.reveal ? ['reveal phase', e.reveal] : ['', 0];
  if (!end) return 'Live · waiting for anyone to call clear()';
  const secs = Math.max(0, Math.ceil((end - now) / 1000));
  return `Live · ${label} · ${secs}s left`;
}

// The countdown ticks every second without re-rendering the page.
window.setInterval(() => {
  const node = document.getElementById('countdown-text');
  const r = rounds[selected];
  if (node && r?.ends) node.textContent = countdownText(r);
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && netActive() && liveContract) void refreshLive();
});

function select(index: number, replay: boolean) {
  selected = index;
  window.clearInterval(replayTimer);
  const r = rounds[selected];
  if (!r) return render();
  if (replay && !reducedMotion) {
    stage = 0;
    replayTimer = window.setInterval(() => {
      stage += 1;
      if (stage >= 3) window.clearInterval(replayTimer);
      renderDetail();
    }, 1000);
  } else {
    stage = STAGE_BY_PHASE[r.phase];
  }
  render();
}

// ---------- rendering ----------

function render() {
  renderKpis();
  renderTrend();
  renderList();
  renderDetail();
}

/** KPI row: four stat tiles, values count up once when they change. */
function renderKpis() {
  const cleared = rounds.filter((r) => r.result?.price != null);
  const prices = cleared.map((r) => num(r.result!.price!));
  const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
  const units = cleared.reduce((s, r) => s + (r.result?.demand ?? 0), 0);
  const paid = rounds.reduce((s, r) => s + (r.result?.settlements.reduce((x, y) => x + y.pay, 0n) ?? 0n), 0n);
  const forfeits = rounds.reduce((s, r) => s + r.forfeited.length, 0);
  const h = headline(rounds.map(roundInputs).map((x, i) => ({ ...x, price: rounds[i]!.result?.price ?? null, demand: rounds[i]!.result?.demand ?? 0 })));
  const more = Math.round(h.moreUnits * 100);
  const tiles: [string, number, (v: number) => string, string][] = [
    ['Rounds cleared', cleared.length, (v) => `${Math.round(v)}`, `of ${rounds.length}${forfeits ? ` · ${forfeits} bond${forfeits === 1 ? '' : 's'} paid to buyers` : ''}`],
    ['Average clearing price', avg, (v) => v.toFixed(2), 'USDC per unit'],
    ['Units bought together', units, (v) => Math.round(v).toLocaleString('en-US'), more > 0 ? `${more}% more than with one winner per round` : `${formatUsdc(paid)} USDC settled`],
    ['Paid below their max', h.belowMax * 100, (v) => `${Math.round(v)}%`, 'what buyers saved vs. the most they offered'],
  ];
  const el = $('kpis');
  if (!el.children.length) {
    el.innerHTML = tiles
      .map(
        ([label]) => `<div class="kpi card"><div class="kpi-label">${label}</div><div class="kpi-value" data-v="0">0</div><div class="kpi-sub"></div></div>`,
      )
      .join('');
  }
  tiles.forEach(([, value, fmt, sub], i) => {
    const tile = el.children[i] as HTMLElement;
    const valueEl = tile.querySelector('.kpi-value') as HTMLElement;
    (tile.querySelector('.kpi-sub') as HTMLElement).textContent = sub;
    countUp(valueEl, value, fmt);
  });
}

function countUp(el: HTMLElement, to: number, fmt: (v: number) => string) {
  const from = Number(el.dataset.v ?? 0);
  el.dataset.v = String(to);
  if (reducedMotion || from === to) {
    el.textContent = fmt(to);
    return;
  }
  const start = performance.now();
  const dur = 700;
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / dur);
    const eased = 1 - (1 - k) ** 3;
    el.textContent = fmt(from + (to - from) * eased);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function pill(phase: ViewRound['phase']) {
  if (phase === 'cleared') return '<span class="pill ok">Cleared</span>';
  if (phase === 'failed') return '<span class="pill bad">No clear</span>';
  return `<span class="pill run"><span class="pulse"></span>${phase === 'clearable' ? 'Clearing' : phase[0]!.toUpperCase() + phase.slice(1)}</span>`;
}

function renderList() {
  $('rounds-count').textContent = rounds.length ? `${rounds.length} loaded` : '';
  $('round-list').innerHTML = rounds
    .map((r, i) => {
      const res = r.result;
      const line =
        res && res.fills.length
          ? `<span class="rl-main">${esc(soldBy(res))} at <b>${usd(res.price)}</b></span><span class="rl-sub">${res.demand} units${r.notes ? ' · AI agents' : ''}</span>`
          : res
            ? '<span class="rl-main">No provider could serve the demand</span><span class="rl-sub">all escrow refunded</span>'
            : `<span class="rl-main">In progress</span><span class="rl-sub">${r.phase} phase</span>`;
      return `<li><button class="round-row${i === selected ? ' on' : ''}" data-i="${i}" aria-current="${i === selected}">
        <span class="rid">#${r.id}</span><span class="rl">${line}</span>${pill(r.phase)}</button></li>`;
    })
    .join('');
}

// ---------- charts (dataviz skill: thin marks, 2px line, >=8px markers, hairline grid, hover tooltips) ----------

function niceTicks(lo: number, hi: number, count = 3): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.001; v += step) out.push(Number(v.toFixed(6)));
  // The top tick must reach the largest value, or bars run past the chart.
  if (out.at(-1)! < hi) out.push(Number((out.at(-1)! + step).toFixed(6)));
  return out;
}

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

/** Tooltip: value leads, label follows; content via textContent only. */
function showTip(x: number, y: number, rows: { value: string; label: string; key?: string }[], title?: string) {
  const tip = $('tip');
  tip.replaceChildren();
  if (title) {
    const t = document.createElement('div');
    t.className = 'tip-title';
    t.textContent = title;
    tip.appendChild(t);
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tip-row';
    if (r.key) {
      const k = document.createElement('span');
      k.className = 'tip-key';
      k.style.background = r.key;
      row.appendChild(k);
    }
    const v = document.createElement('strong');
    v.textContent = r.value;
    const l = document.createElement('span');
    l.textContent = r.label;
    row.append(v, l);
    tip.appendChild(row);
  }
  tip.hidden = false;
  const pad = 14;
  const { width, height } = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - width - 8, x + pad);
  const top = y - height - pad < 8 ? y + pad : y - height - pad;
  tip.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
}
const hideTip = () => ($('tip').hidden = true);

/** Clearing price per round: one series, so no legend (the title names it). */
function renderTrend() {
  const host = $('trend');
  host.replaceChildren();
  const pts = rounds.map((r, i) => ({ i, id: r.id, price: r.result?.price != null ? num(r.result.price) : null, failed: r.phase === 'failed' }));
  const vals = pts.filter((p) => p.price !== null).map((p) => p.price!);
  if (!vals.length) return;
  const W = 320;
  const H = 150;
  const m = { l: 34, r: 14, t: 14, b: 22 };
  const ticks = niceTicks(Math.min(...vals) - 0.03, Math.max(...vals) + 0.03, 3);
  const lo = ticks[0]!;
  const hi = ticks.at(-1)!;
  const x = (i: number) => m.l + (rounds.length === 1 ? (W - m.l - m.r) / 2 : (i * (W - m.l - m.r)) / (rounds.length - 1));
  const y = (v: number) => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz', role: 'presentation' }, host);
  for (const t of ticks) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: 'grid' }, svg);
    el('text', { x: m.l - 6, y: y(t) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = t.toFixed(2);
  }
  // X ticks: first and last round only.
  for (const p of [pts[0]!, pts.at(-1)!]) {
    el('text', { x: x(p.i), y: H - 5, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = `#${p.id}`;
  }
  const line = pts.filter((p) => p.price !== null);
  el('path', { d: line.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.price!).toFixed(1)}`).join(''), class: 'trend-line' }, svg);
  const cross = el('line', { y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' }, svg);
  for (const p of pts) {
    if (p.price === null) {
      if (p.failed) el('circle', { cx: x(p.i), cy: H - m.b, r: 4, class: 'dot fail' }, svg);
      continue;
    }
    el('circle', { cx: x(p.i), cy: y(p.price), r: p.i === selected ? 6 : 4, class: `dot${p.i === selected ? ' on' : ''}` }, svg);
  }
  // Selective direct label: the selected round's price.
  const sel = pts[selected];
  if (sel && sel.price !== null) {
    // Keep the label clear of the y-axis labels on the left and the edge on the right.
    const sx = x(sel.i);
    const anchor = sx < m.l + 24 ? 'start' : sx > W - 40 ? 'end' : 'middle';
    const lx = anchor === 'start' ? sx + 8 : anchor === 'end' ? sx - 8 : sx;
    el('text', { x: lx, y: Math.max(11, y(sel.price) - 10), class: 'tick strong', 'text-anchor': anchor }, svg).textContent = sel.price.toFixed(2);
  }
  // Crosshair hit layer: snaps to the nearest round.
  const hit = el('rect', { x: m.l - 8, y: 0, width: W - m.l - m.r + 16, height: H, fill: 'transparent', tabindex: 0, 'aria-label': 'Clearing price per round. Use left and right keys.' }, svg);
  const nearest = (clientX: number) => {
    const b = svg.getBoundingClientRect();
    const vx = ((clientX - b.left) / b.width) * W;
    let best = pts[0]!;
    for (const p of pts) if (Math.abs(x(p.i) - vx) < Math.abs(x(best.i) - vx)) best = p;
    return best;
  };
  const show = (p: (typeof pts)[number], cx: number, cy: number) => {
    cross.setAttribute('x1', String(x(p.i)));
    cross.setAttribute('x2', String(x(p.i)));
    cross.setAttribute('visibility', 'visible');
    const r = rounds[p.i]!;
    showTip(cx, cy, [
      { value: p.price !== null ? `${p.price.toFixed(2)} USDC` : 'no clear', label: 'clearing price', key: 'var(--series-1)' },
      { value: soldBy(r.result) || '—', label: r.result && r.result.fills.length > 1 ? 'providers' : 'provider' },
    ], `Round ${p.id}`);
  };
  hit.addEventListener('pointermove', (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    hideTip();
  });
  hit.addEventListener('click', (e) => select(nearest(e.clientX).i, false));
  hit.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' && selected > 0) select(selected - 1, false);
    if (e.key === 'ArrowRight' && selected < rounds.length - 1) select(selected + 1, false);
  });
}

/** Rounded data-end, square at the baseline (4px). */
function barPath(x: number, y: number, w: number, h: number, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * The clearing rule as a picture: each revealed ask, cheapest first, with the units buyers want
 * at that price next to the capacity of every provider asking that much or less. The first ask
 * where capacity covers demand is the clearing price. Two series: legend always, direct label
 * only on the clearing ask, and units sold under each provider that sells.
 */
function ladderChart(r: ViewRound, showResult: boolean): HTMLElement | null {
  const bids = r.sellers.filter((s) => s.revealed).sort((a, b) =>
    a.revealed!.price === b.revealed!.price ? a.commitIndex - b.commitIndex : a.revealed!.price < b.revealed!.price ? -1 : 1,
  );
  if (!bids.length) return null;
  const rows: { id: string; price: bigint; demand: number; supply: number; buyer?: boolean }[] = bids.map((s) => ({
    id: s.id,
    price: s.revealed!.price,
    demand: r.buyers.reduce((sum, b) => (b.maxPrice >= s.revealed!.price ? sum + b.qty : sum), 0),
    supply: bids.reduce((sum, x) => (x.revealed!.price <= s.revealed!.price ? sum + x.revealed!.capacity : sum), 0),
  }));
  const res = showResult ? r.result : null;
  const sold = new Map(res?.fills.map((f) => [f.id, f.units]) ?? []);
  // When a buyer's max price is the clearing price, it gets its own column in the ladder.
  const setterBuyer = res?.priceSetBy ? r.buyers.find((b) => b.id === res.priceSetBy) : undefined;
  if (setterBuyer && res?.price != null) {
    const price = res.price;
    rows.push({
      id: setterBuyer.id,
      price,
      demand: r.buyers.reduce((sum, b) => (b.maxPrice >= price ? sum + b.qty : sum), 0),
      supply: bids.reduce((sum, x) => (x.revealed!.price <= price ? sum + x.revealed!.capacity : sum), 0),
      buyer: true,
    });
    rows.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  }
  const wrap = document.createElement('div');
  wrap.className = 'ladder';
  wrap.innerHTML = `<div class="legend"><span><i style="background:var(--series-1)"></i>Units wanted at this price</span><span><i style="background:var(--series-2)"></i>Capacity at this price or less</span></div>`;
  // (rows may gain a buyer-named clearing price below, once the result is known)
  // Narrower viewBox for few providers, so text stays readable on a phone.
  const W = Math.max(320, Math.min(560, rows.length * 130));
  const H = 244;
  const m = { l: 36, r: 8, t: 30, b: 58 };
  const max = Math.max(...rows.flatMap((x) => [x.demand, x.supply]), 1);
  const ticks = niceTicks(0, max, 3);
  const top = ticks.at(-1)!;
  const band = (W - m.l - m.r) / rows.length;
  const bw = Math.min(24, (band - 18) / 2);
  const y = (v: number) => m.t + (1 - v / top) * (H - m.t - m.b);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz', role: 'img', 'aria-label': 'Units wanted versus capacity available, per ask, cheapest first' }, wrap);
  for (const t of ticks) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: 'grid' }, svg);
    el('text', { x: m.l - 6, y: y(t) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = String(t);
  }
  rows.forEach((row, i) => {
    const cx = m.l + band * i + band / 2;
    const isPrice = res?.priceSetBy === row.id;
    const sells = sold.get(row.id) ?? 0;
    const g = el('g', { class: `pair${isPrice || sells ? ' win' : ''}${res && !isPrice && !sells ? ' dim' : ''}` }, svg);
    const bars: [number, string, string][] = [
      [row.demand, 'var(--series-1)', 'units wanted at this price'],
      [row.supply, 'var(--series-2)', 'capacity at this price or less'],
    ];
    bars.forEach(([v, color, label], k) => {
      const bx = cx - bw - 1 + k * (bw + 2); // 2px surface gap between the pair
      const path = el('path', { d: barPath(bx, y(v), bw, y(0) - y(v)), fill: color, class: 'bar' }, g);
      const hit = el('rect', { x: bx - 3, y: m.t, width: bw + 6, height: y(0) - m.t, fill: 'transparent', tabindex: 0 }, g);
      const tip = (cxp: number, cyp: number) => {
        path.classList.add('hover');
        showTip(cxp, cyp, [{ value: `${v} units`, label, key: color }], `${plain(row.id)} ${row.buyer ? 'max price' : 'asks'} ${formatUsdc(row.price)}`);
      };
      hit.addEventListener('pointermove', (e) => tip(e.clientX, e.clientY));
      hit.addEventListener('focus', () => {
        const b = hit.getBoundingClientRect();
        tip(b.right, b.top + 20);
      });
      const off = () => {
        path.classList.remove('hover');
        hideTip();
      };
      hit.addEventListener('pointerleave', off);
      hit.addEventListener('blur', off);
    });
    el('text', { x: cx, y: H - m.b + 16, class: 'tick strong', 'text-anchor': 'middle' }, g).textContent = plain(row.id);
    el('text', { x: cx, y: H - m.b + 30, class: 'tick', 'text-anchor': 'middle' }, g).textContent = `${row.buyer ? 'max' : 'asks'} ${formatUsdc(row.price)}`;
    if (res && !row.buyer) {
      el('text', { x: cx, y: H - m.b + 44, class: `tick${sells ? ' strong' : ''}`, 'text-anchor': 'middle' }, g).textContent = sells ? `sells ${sells}` : 'sells 0';
    }
    if (isPrice) {
      el('text', { x: cx, y: Math.max(12, Math.min(y(row.demand), y(row.supply)) - 8), class: 'tick strong', 'text-anchor': 'middle' }, g).textContent = 'clears';
    }
  });
  el('line', { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), class: 'axis' }, svg);
  return wrap;
}

// ---------- detail ----------

function renderDetail() {
  const r = rounds[selected];
  const host = $('detail');
  if (!r) {
    host.innerHTML = '<p class="muted">Run the simulation or load a testnet contract to see rounds.</p>';
    return;
  }
  const res = r.result;
  const showResult = stage >= 3 && res !== null;
  const sold = new Map(showResult ? res.fills.map((f) => [f.id, f]) : []);
  const escrow = r.buyers.reduce((s, b) => s + b.escrow, 0n);
  const units = r.buyers.reduce((s, b) => s + b.qty, 0);
  const revealed = r.sellers.filter((s) => s.revealed).length;
  const forfeited = r.sellers.length - revealed;
  const paid = res?.settlements.reduce((s, x) => s + x.pay, 0n) ?? 0n;
  const refunded = res?.settlements.reduce((s, x) => s + x.refund, 0n) ?? 0n;
  const ai = r.notes?.brain.startsWith('nearai:') ? r.notes.brain.slice(7) : null;

  // Activity trace (EasyUI "AI Agent Activity" pattern).
  const summaries = [
    `${r.buyers.length} buyer agents locked ${usd(escrow)} USDC for ${units} units`,
    `${r.sellers.length} sealed bids posted, each backed by a NEAR bond`,
    forfeited ? `${revealed} revealed · ${forfeited} kept quiet; its bond goes to the buyers` : `All ${revealed} bids revealed and matched their hashes`,
    res
      ? res.fills.length
        ? `Cleared at ${usd(res.price)}: ${res.fills.map((f) => `${plain(f.id)} sells ${f.units}`).join(', ')} · ${usd(paid)} USDC paid, ${usd(refunded)} refunded`
        : 'No provider could serve the demand · every buyer refunded in full'
      : 'Waiting for the reveal phase to end',
  ];
  const trace = STAGES.map((name, i) => {
    const state = i < stage || (i === stage && stage === 3 && res) ? 'done' : i === stage ? 'run' : 'todo';
    return `<li class="step ${state}"><span class="step-icon" aria-hidden="true"></span><div><div class="step-name">${name}</div><div class="step-sub">${state === 'todo' ? '—' : esc(summaries[i]!)}</div></div></li>`;
  }).join('');

  const steps = showResult
    ? explainClear(
        r.buyers.map((b) => ({ id: b.id, qty: b.qty, maxPrice: b.maxPrice })),
        r.sellers.filter((s) => s.revealed).map((s) => ({ id: s.id, price: s.revealed!.price, capacity: s.revealed!.capacity, commitIndex: s.commitIndex })),
      )
    : [];
  // Ties at the clearing price: the earlier commit fills first.
  const tieNote =
    showResult && res.price !== null
      ? r.sellers
          .filter((x) => x.revealed?.price === res.price)
          .sort((a, b) => a.commitIndex - b.commitIndex)
          .slice(1)
          .filter((x) => (sold.get(x.id)?.units ?? 0) < x.revealed!.capacity)
          .map((x) => `<li class="skip">${short(x.id)} also asked ${usd(x.revealed!.price)} but committed later; ties go to the earlier commit</li>`)
          .join('')
      : '';
  const setterIsBuyer = showResult && !!res.priceSetBy && r.buyers.some((b) => b.id === res.priceSetBy);
  const setterNote = !showResult || !res.priceSetBy
    ? ''
    : setterIsBuyer
      ? `<li class="skip">${short(res.priceSetBy)}'s max price became the clearing price: it is included and pays exactly its max</li>`
      : !sold.has(res.priceSetBy)
        ? `<li class="skip">${short(res.priceSetBy)}'s ask set the price, but cheaper providers could make every unit, so it sells nothing</li>`
        : '';
  const split = showResult && res.fills.length
    ? `<li class="win">Units go to the cheapest providers first: ${res.fills
        .map((f) => `<b>${short(f.id)}</b> sells ${f.units}`)
        .join(', ')}. Each is paid <b>${usd(res.price)}</b> per unit.</li>`
    : '';
  // Long runs of "not enough" collapse to the first and the last, so the list stays short.
  const shown = steps.length > 4 ? [steps[0]!, null, ...steps.slice(-2)] : steps;
  const stepLine = (st: (typeof steps)[number] | null) =>
    st === null
      ? `<li class="skip">… ${steps.length - 3} more prices tried, none with enough capacity</li>`
      : `<li class="${st.outcome === 'clears' ? 'win' : 'skip'}">Try <b>${usd(st.price)}</b> (${short(st.id)}'s ${st.kind === 'ask' ? 'ask' : 'max price'}): ${st.demand} units wanted at that price, providers asking this or less can make ${st.supply} → ${
          st.outcome === 'clears' ? '<b>clears</b>' : st.outcome === 'no-demand' ? 'no buyer pays this much' : 'not enough, try the next price'
        }</li>`;
  // A round cleared on-chain by an earlier version of the rule keeps its stored result.
  const lastStep = steps.at(-1);
  const failedChecks = showResult && r.source === 'testnet' ? verify(r) : [];
  const legacy = showResult && (failedChecks.length > 0 || (res.price !== null && (lastStep?.outcome !== 'clears' || lastStep.price !== res.price)));
  const verifiedLine = showResult && r.source === 'testnet' && !legacy
    ? '<li class="ok-line">✓ Your browser just re-ran this rule on the on-chain bids and got the same price, fills and payments as the contract.</li>'
    : '';
  const quiet = showResult ? r.sellers.filter((x) => !x.revealed) : [];
  const bondNote = quiet.length
    ? `<li class="skip">${quiet.map((x) => short(x.id)).join(', ')} never revealed: ${
        r.bond !== undefined ? `${formatNear(r.bond * BigInt(quiet.length))} NEAR of bond` : 'its bond'
      } is split among the buyers by units locked${r.bondShares?.length ? ' (see the buyers table)' : ''}</li>`
    : '';
  const why = showResult
    ? `<section class="block"><h3>Why this result</h3><ol class="why">${
        legacy
          ? `<li class="skip">This round was cleared on-chain by an earlier version of the clearing rule. The result below is what the contract recorded.</li>${split}`
          : `${shown.map(stepLine).join('') || '<li class="skip">No provider revealed a bid.</li>'}${split}${setterNote}${tieNote}`
      }${bondNote}${verifiedLine}${res.fills.length ? '' : '<li class="skip"><b>No price cleared: every buyer gets the full escrow back.</b></li>'}</ol></section>`
    : '';

  const thought = (id: string, fallback?: string) => {
    const n = r.notes?.byAgent[id];
    if (!n) return `<span class="muted">${esc(fallback ?? '—')}</span>`;
    const tag = n.source === 'ai' ? '' : ` <span class="pill">${esc(n.source)}</span>`;
    return `<span class="thought"><span class="spark" aria-hidden="true">✦</span>${esc(n.reasoning)}${tag}</span>`;
  };
  const whyHead = r.notes ? 'Agent reasoning' : 'Strategy';

  const sellers =
    stage >= 1
      ? `<section class="block"><h3>Providers <span class="muted">${r.sellers.length}</span></h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Provider</th><th class="wide">${whyHead}</th><th>Sealed bid</th><th class="num">Price</th><th class="num">Capacity</th>${
          showResult ? '<th class="num">Sells</th><th class="num">Earns</th>' : ''
        }<th>Status</th></tr></thead>
        <tbody>${[...r.sellers]
          .sort((a, b) => a.commitIndex - b.commitIndex)
          .map((s) => {
            const open = stage >= 2 && s.revealed;
            const fill = sold.get(s.id);
            const status =
              fill
                ? '<span class="pill ok">Winner</span>'
                : stage < 2
                  ? '<span class="pill">Sealed</span>'
                  : s.revealed
                    ? '<span class="pill info">Revealed</span>'
                    : '<span class="pill bad">Bond forfeited</span>';
            return `<tr class="${fill ? 'win-row' : ''}">
              <td class="who">${short(s.id)}</td><td class="wide">${stage >= 3 ? thought(s.id, s.strategy) : `<span class="muted">${esc(s.strategy ?? 'hidden until the round clears')}</span>`}</td>
              <td><code title="${esc(s.commitment)}">${esc(s.commitment.slice(0, 10))}…</code></td>
              <td class="num">${open ? usd(s.revealed!.price) : '<span class="sealed">••••</span>'}</td>
              <td class="num">${open ? s.revealed!.capacity : '<span class="sealed">••</span>'}</td>${
                showResult ? `<td class="num">${fill ? fill.units : '—'}</td><td class="num">${fill ? usd(fill.payout) : '—'}</td>` : ''
              }<td>${status}</td></tr>`;
          })
          .join('')}</tbody></table></div></section>`
      : '';

  const settle = new Map(res?.settlements.map((s) => [s.id, s]) ?? []);
  const bondOf = new Map(r.bondShares?.map((b) => [b.id, b.amount]) ?? []);
  const bondCol = showResult && bondOf.size > 0;
  const buyers = `<section class="block"><h3>Buyers <span class="muted">${r.buyers.length}</span></h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Buyer</th><th class="wide">${whyHead}</th><th class="num">Units</th><th class="num">Max</th><th class="num">Escrow</th>${
        showResult ? `<th class="num">Pays</th><th class="num">Refund</th>${bondCol ? '<th class="num">Bond (NEAR)</th>' : ''}<th>Result</th>` : ''
      }</tr></thead>
      <tbody>${r.buyers
        .map((b) => {
          const s = settle.get(b.id);
          return `<tr class="${showResult && s && !s.included ? 'out-row' : ''}">
            <td class="who">${short(b.id)}</td><td class="wide">${thought(b.id, b.strategy)}</td>
            <td class="num">${b.qty}</td><td class="num">${usd(b.maxPrice)}</td><td class="num">${usd(b.escrow)}</td>${
              showResult && s
                ? `<td class="num">${s.included ? usd(s.pay) : '—'}</td><td class="num">${usd(s.refund)}</td>${
                    bondCol ? `<td class="num">${bondOf.has(b.id) ? `+${formatNear(bondOf.get(b.id)!)}` : '—'}</td>` : ''
                  }<td>${s.included ? '<span class="pill ok">Included</span>' : '<span class="pill">Out</span>'}</td>`
                : ''
            }</tr>`;
        })
        .join('')}</tbody></table></div></section>`;

  host.innerHTML = `
    <div class="detail-head">
      <div>
        <div class="crumb">${r.source === 'testnet' ? 'Live on NEAR testnet' : 'Simulation'} · ${esc(r.unit)}</div>
        <h2>Round ${r.id} ${pill(stage >= 3 ? r.phase : (['join', 'commit', 'reveal'] as const)[Math.min(stage, 2)]!)}</h2>
      </div>
      <div class="head-actions">
        ${r.source === 'testnet' && isLive(r) ? `<span class="pill run live-tag"><span class="pulse"></span><span id="countdown-text">${esc(countdownText(r))}</span></span>` : ''}
        ${ai ? `<span class="badge"><span class="spark" aria-hidden="true">✦</span> AI agents · NEAR AI · ${esc(ai)}</span>` : ''}
        ${showResult && r.source === 'testnet'
          ? legacy
            ? `<span class="pill" title="Cleared by an earlier version of the rule: ${esc(failedChecks.join(', '))}">Earlier rule version</span>`
            : '<span class="pill ok" title="Your browser re-ran the clearing rule on the on-chain bids and matched every number">✓ Verified in your browser</span>'
          : ''}
        ${res ? '<button id="replay" class="ghost" type="button">Replay round</button>' : ''}
      </div>
    </div>
    <div class="detail-grid">
      <section class="block"><h3>Activity</h3><ol class="trace">${trace}</ol></section>
      <section class="block" id="ladder-slot"><h3>Price ladder <span class="muted">prices tried, cheapest first</span></h3></section>
    </div>
    ${why}${sellers}${buyers}`;

  const slot = host.querySelector('#ladder-slot') as HTMLElement;
  const chart = stage >= 2 ? ladderChart(r, showResult) : null;
  if (chart) slot.appendChild(chart);
  else slot.insertAdjacentHTML('beforeend', '<p class="muted empty">Prices appear here when the providers reveal their sealed bids.</p>');
}

// ---------- events ----------

$('sim-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runSim();
});
$('net-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void loadNet();
});
function setTab(net: boolean) {
  $('tab-sim').setAttribute('aria-selected', String(!net));
  $('tab-net').setAttribute('aria-selected', String(net));
  $('sim-form').hidden = net;
  $('net-form').hidden = !net;
}
/** The product sits below the landing sections, so the top-bar tabs also bring it into view. */
function showApp() {
  $('app').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
}
$('tab-sim').addEventListener('click', () => {
  setTab(false);
  window.clearTimeout(liveTimer);
  runSim();
  showApp();
});
$('tab-net').addEventListener('click', () => {
  setTab(true);
  void loadNet();
  showApp();
});
document.addEventListener('click', (e) => {
  const target = e.target as Element;
  const pick = target.closest('.round-row[data-i]');
  if (pick) select(Number(pick.getAttribute('data-i')), false);
  if (target.closest('#replay')) select(selected, true);
  const go = target.closest('[data-goto]');
  if (go) void gotoRound(go.getAttribute('data-goto')!);
});

// ---------- Simulated vs live: the live column, computed from the contract ----------

const LIVE_CONTRACT = 'market.hivebuy.testnet';

async function renderEvidence() {
  const set = (key: string, text: string) => {
    const cell = document.querySelector(`[data-live="${key}"]`);
    if (cell) cell.textContent = text;
  };
  try {
    const live = (await loadTestnetRounds(LIVE_CONTRACT)).filter((r) => r.result && (r.phase === 'cleared' || r.phase === 'failed'));
    const h = headline(live.map((r) => ({ ...roundInputs(r), price: r.result!.price, demand: r.result!.demand })));
    set('more', `${h.moreUnits >= 0 ? '+' : ''}${Math.round(h.moreUnits * 100)}%`);
    set('below', `${Math.round(h.belowMax * 100)}%`);
    set('rounds', String(live.filter((r) => r.phase === 'cleared').length));
    set('multi', String(live.filter((r) => r.result!.fills.length >= 2).length));
    set('forfeits', String(live.reduce((a, r) => a + r.sellers.filter((x) => !x.revealed).length, 0)));
    $('ev-asof').textContent = `at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    for (const key of ['more', 'below', 'rounds', 'multi', 'forfeits']) set(key, '—');
    $('ev-asof').textContent = '(testnet RPC unreachable right now)';
  }
}
void renderEvidence();

const params = new URLSearchParams(location.search);
if (params.get('contract')) {
  setTab(true);
  $<HTMLInputElement>('contract').value = params.get('contract')!;
  void loadNet().then(() => $('app').scrollIntoView({ block: 'start' }));
} else {
  runSim();
}
