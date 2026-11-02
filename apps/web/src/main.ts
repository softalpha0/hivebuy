import './style.css';
import { explainClear, formatUsdc } from '@hivebuy/core';
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

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let rounds: ViewRound[] = [];
let selected = 0;
let stage = 3;
let replayTimer: number | undefined;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const short = (id: string | null) => (id ? esc(id.split('.')[0] ?? id) : '—');
const usd = (a: bigint | null) => (a === null ? '—' : formatUsdc(a));

// ---------- data ----------

function runSim() {
  const seed = Math.max(1, Number($<HTMLInputElement>('seed').value) || 42);
  const count = Math.min(50, Math.max(1, Number($<HTMLInputElement>('rounds').value) || 10));
  rounds = fromSimulation(runSimulation({ seed, rounds: count }));
  select(0, true);
}

async function loadNet() {
  const contract = $<HTMLInputElement>('contract').value.trim();
  const status = $('net-status');
  if (!contract) {
    status.textContent = 'Enter the coordinator contract account, for example market.hivebuy.testnet.';
    return;
  }
  status.textContent = 'Loading…';
  try {
    const loaded = await loadTestnetRounds(contract);
    if (loaded.length === 0) {
      status.textContent = 'No rounds on this contract yet. Open one with the testnet script.';
      return;
    }
    rounds = loaded;
    status.textContent = `${loaded.length} round(s) from ${contract} on NEAR testnet.`;
    select(rounds.length - 1, false);
  } catch (e) {
    status.textContent = `Could not read ${contract}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function select(index: number, replay: boolean) {
  selected = index;
  window.clearInterval(replayTimer);
  const r = rounds[selected];
  if (!r) return render();
  if (replay) {
    stage = 0;
    replayTimer = window.setInterval(() => {
      stage += 1;
      if (stage >= 3) window.clearInterval(replayTimer);
      renderDetail();
    }, 900);
  } else {
    stage = STAGE_BY_PHASE[r.phase];
  }
  render();
}

// ---------- rendering ----------

function render() {
  renderChart();
  renderList();
  renderDetail();
}

function renderList() {
  $('round-list').innerHTML = rounds
    .map((r, i) => {
      const res = r.result;
      const line =
        res && res.winner
          ? `${short(res.winner)} · ${usd(res.price)} · ${res.demand} units`
          : res
            ? 'no seller could serve the demand'
            : `${r.phase} phase`;
      return `<li><button class="round-btn${i === selected ? ' on' : ''}" data-i="${i}" aria-current="${i === selected}">
        <span class="rid">#${r.id}</span><span>${line}</span></button></li>`;
    })
    .join('');
}

function renderChart() {
  // Open rounds (no result yet) get no mark; failed rounds get a dashed mark on the baseline.
  const points = rounds.map((r, i) => ({ i, price: r.result?.price ?? null, open: r.result === null }));
  const prices = points.filter((p) => p.price !== null).map((p) => Number(p.price) / 1e6);
  if (prices.length === 0) {
    $('chart').innerHTML = '';
    return;
  }
  const W = 300;
  const H = 140;
  const pad = 18;
  const lo = Math.min(...prices) - 0.05;
  const hi = Math.max(...prices) + 0.05;
  const x = (i: number) => pad + (rounds.length === 1 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (rounds.length - 1));
  const y = (v: number) => H - pad - ((v - lo) / (hi - lo)) * (H - 2 * pad);
  const line = points
    .filter((p) => p.price !== null)
    .map((p) => `${x(p.i).toFixed(1)},${y(Number(p.price) / 1e6).toFixed(1)}`)
    .join(' ');
  const dots = points
    .filter((p) => !p.open)
    .map((p) =>
      p.price === null
        ? `<circle class="dot fail" cx="${x(p.i)}" cy="${H - pad}" r="4" data-i="${p.i}"><title>Round ${rounds[p.i]!.id}: no clear</title></circle>`
        : `<circle class="dot${p.i === selected ? ' on' : ''}" cx="${x(p.i)}" cy="${y(Number(p.price) / 1e6)}" r="${p.i === selected ? 6 : 4}" data-i="${p.i}"><title>Round ${rounds[p.i]!.id}: ${usd(p.price)} USDC</title></circle>`,
    )
    .join('');
  $('chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">
    <text class="axis" x="${pad}" y="14">clearing price (USDC / unit)</text>
    <text class="axis" x="${W - pad}" y="${y(hi - 0.05) - 6}" text-anchor="end">${(hi - 0.05).toFixed(2)}</text>
    ${hi - lo > 0.1001 ? `<text class="axis" x="${W - pad}" y="${y(lo + 0.05) + 14}" text-anchor="end">${(lo + 0.05).toFixed(2)}</text>` : ''}
    <polyline class="line" points="${line}" />${dots}</svg>`;
}

function renderDetail() {
  const r = rounds[selected];
  const el = $('detail');
  if (!r) {
    el.innerHTML = '<p class="muted">Run the simulation or load a testnet contract to see rounds.</p>';
    return;
  }
  const res = r.result;
  const showResult = stage >= 3 && res !== null;
  const winner = showResult ? res.winner : null;

  const stepper = STAGES.map(
    (s, i) => `<li class="${i < stage ? 'done' : i === stage ? 'now' : ''}">${s}</li>`,
  ).join('');

  const escrowTotal = r.buyers.reduce((s, b) => s + b.escrow, 0n);
  const paid = res?.settlements.reduce((s, x) => s + x.pay, 0n) ?? 0n;
  const refunded = res?.settlements.reduce((s, x) => s + x.refund, 0n) ?? 0n;
  const requested = r.buyers.reduce((s, b) => s + b.qty, 0);

  const summary = showResult
    ? `<dl class="stats">
        <div><dt>Winner</dt><dd>${short(res.winner)}</dd></div>
        <div><dt>Clearing price</dt><dd>${usd(res.price)}</dd></div>
        <div><dt>Units served</dt><dd>${res.demand} <span class="muted">of ${requested}</span></dd></div>
        <div><dt>Paid to winner</dt><dd>${usd(paid)}</dd></div>
        <div><dt>Refunded</dt><dd>${usd(refunded)}</dd></div>
        <div><dt>Bonds forfeited</dt><dd>${r.forfeited.length}</dd></div>
      </dl>`
    : `<dl class="stats">
        <div><dt>Buyers joined</dt><dd>${r.buyers.length}</dd></div>
        <div><dt>Units requested</dt><dd>${requested}</dd></div>
        <div><dt>USDC in escrow</dt><dd>${usd(escrowTotal)}</dd></div>
        <div><dt>Sealed bids</dt><dd>${stage >= 1 ? r.sellers.length : 0}</dd></div>
      </dl>`;

  const steps = showResult
    ? explainClear(
        r.buyers.map((b) => ({ id: b.id, qty: b.qty, maxPrice: b.maxPrice })),
        r.sellers.filter((s) => s.revealed).map((s) => ({ id: s.id, price: s.revealed!.price, capacity: s.revealed!.capacity, commitIndex: s.commitIndex })),
      )
    : [];
  const trace = showResult
    ? `<h3>Why this result</h3><ol class="trace">${
        steps
          .map(
            (s) =>
              `<li class="${s.outcome}"><strong>${short(s.id)}</strong> at ${usd(s.price)}: ${s.demand} units wanted at that price, capacity ${s.capacity} → ${
                s.outcome === 'wins' ? '<b>wins</b>' : s.outcome === 'no-demand' ? 'no buyer pays this much' : 'not enough capacity, skip'
              }</li>`,
          )
          .join('') || '<li>No seller revealed a bid.</li>'
      }${res.winner ? '' : '<li><b>No seller qualified: every buyer gets the full escrow back.</b></li>'}</ol>`
    : '';

  const sellers = stage >= 1
    ? `<h3>Sellers <span class="muted">(${r.sellers.length})</span></h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Seller</th><th>Strategy</th><th>Commitment</th><th class="num">Price</th><th class="num">Capacity</th><th>Status</th></tr></thead>
        <tbody>${[...r.sellers]
          .sort((a, b) => a.commitIndex - b.commitIndex)
          .map((s) => {
            const open = stage >= 2 && s.revealed;
            const status =
              winner === s.id
                ? '<span class="pill win">winner</span>'
                : stage < 2
                  ? '<span class="pill">sealed</span>'
                  : s.revealed
                    ? '<span class="pill">revealed</span>'
                    : '<span class="pill warn">no reveal, bond forfeited</span>';
            return `<tr class="${winner === s.id ? 'win-row' : ''}">
              <td>${short(s.id)}</td><td class="muted">${esc(s.strategy ?? '—')}</td>
              <td><code title="${esc(s.commitment)}">${esc(s.commitment.slice(0, 10))}…</code></td>
              <td class="num">${open ? usd(s.revealed!.price) : '••••'}</td>
              <td class="num">${open ? s.revealed!.capacity : '••'}</td><td>${status}</td></tr>`;
          })
          .join('')}</tbody></table></div>`
    : '<p class="muted">Sellers commit sealed bids once the join phase ends.</p>';

  const settle = new Map(res?.settlements.map((s) => [s.id, s]) ?? []);
  const buyers = `<h3>Buyers <span class="muted">(${r.buyers.length})</span></h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Buyer</th><th>Strategy</th><th class="num">Qty</th><th class="num">Max</th><th class="num">Escrow</th>${
        showResult ? '<th class="num">Pays</th><th class="num">Refund</th>' : ''
      }</tr></thead>
      <tbody>${r.buyers
        .map((b) => {
          const s = settle.get(b.id);
          return `<tr class="${showResult && s && !s.included ? 'out-row' : ''}">
            <td>${short(b.id)}</td><td class="muted">${esc(b.strategy ?? '—')}</td>
            <td class="num">${b.qty}</td><td class="num">${usd(b.maxPrice)}</td><td class="num">${usd(b.escrow)}</td>${
              showResult && s ? `<td class="num">${s.included ? usd(s.pay) : '<span class="muted">out</span>'}</td><td class="num">${usd(s.refund)}</td>` : ''
            }</tr>`;
        })
        .join('')}</tbody></table></div>`;

  el.innerHTML = `
    <div class="detail-head">
      <h2>Round ${r.id} <span class="muted">· ${esc(r.unit)} · ${r.source}</span></h2>
      ${res ? '<button id="replay" class="ghost" type="button">Replay round</button>' : ''}
    </div>
    <ol class="stepper">${stepper}</ol>
    ${summary}${trace}${sellers}${buyers}`;
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
for (const [tab, form, other, otherForm] of [
  ['tab-sim', 'sim-form', 'tab-net', 'net-form'],
  ['tab-net', 'net-form', 'tab-sim', 'sim-form'],
] as const) {
  $(tab).addEventListener('click', () => {
    $(tab).setAttribute('aria-selected', 'true');
    $(other).setAttribute('aria-selected', 'false');
    $(form).hidden = false;
    $(otherForm).hidden = true;
  });
}
document.addEventListener('click', (e) => {
  const target = e.target as Element;
  const pick = target.closest('[data-i]');
  if (pick) select(Number(pick.getAttribute('data-i')), false);
  if (target.closest('#replay')) select(selected, true);
});

const params = new URLSearchParams(location.search);
if (params.get('contract')) {
  $('tab-net').click();
  $<HTMLInputElement>('contract').value = params.get('contract')!;
  void loadNet();
} else {
  runSim();
}
