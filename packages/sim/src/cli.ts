import { writeFileSync } from 'node:fs';
import { formatUsdc, headline } from '@hivebuy/core';
import { runSimulation, toJson } from './index.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const seed = Number(arg('seed', '42'));
const rounds = Number(arg('rounds', '8'));
const out = arg('json', '');

const run = runSimulation({ seed, rounds });
const short = (id: string | null): string => (id ? (id.split('.')[0] ?? id) : '-');

console.log(`Hivebuy simulation · seed ${seed} · ${run.buyers.length} buyers · ${run.sellers.length} sellers · no LLM calls\n`);
console.log('round  status   providers                price   demand  paid      refunded  forfeited');
for (const r of run.rounds) {
  const price = r.result.status === 'cleared' ? formatUsdc(r.result.price) : '-';
  console.log(
    [
      String(r.id).padEnd(6),
      r.result.status.padEnd(8),
      (r.result.fills.map((f) => `${short(f.id)}:${f.units}`).join(',') || '-').padEnd(24),
      price.padStart(6),
      String(r.stats.demandAtClear).padStart(7),
      formatUsdc(r.stats.paidToProviders).padStart(9),
      formatUsdc(r.stats.refunded).padStart(9),
      r.forfeited.map(short).join(',') || '-',
    ].join(' '),
  );
}

// Headline: this run, and optionally several seeds (npm run sim -- --rounds 50 --seeds 42,7,123,2026).
const seeds = arg('seeds', String(seed)).split(',').map(Number);
const all = seeds.flatMap((sd) => (sd === seed ? run : runSimulation({ seed: sd, rounds })).rounds);
const h = headline(all.map((r) => ({ buyers: r.buyers, bids: r.sellers.filter((x) => x.revealed), price: r.result.price, demand: r.result.demand })));
console.log(
  `\n${all.length} rounds (seed${seeds.length > 1 ? 's' : ''} ${seeds.join(', ')}): ${h.units} units bought vs ${h.oneWinnerUnits} with one winner per round ` +
    `(+${(h.moreUnits * 100).toFixed(1)}%); included buyers paid ${(h.belowMax * 100).toFixed(1)}% below their max.`,
);

if (out) {
  writeFileSync(out, JSON.stringify(toJson(run), null, 2));
  console.log(`\nFull run written to ${out}`);
}
