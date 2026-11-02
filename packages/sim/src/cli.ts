import { writeFileSync } from 'node:fs';
import { formatUsdc } from '@hivebuy/core';
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
console.log('round  status   winner     price   demand  paid      refunded  forfeited');
for (const r of run.rounds) {
  const price = r.result.status === 'cleared' ? formatUsdc(r.result.price) : '-';
  console.log(
    [
      String(r.id).padEnd(6),
      r.result.status.padEnd(8),
      short(r.result.winner).padEnd(10),
      price.padStart(6),
      String(r.stats.demandAtClear).padStart(7),
      formatUsdc(r.stats.paidToWinner).padStart(9),
      formatUsdc(r.stats.refunded).padStart(9),
      r.forfeited.map(short).join(',') || '-',
    ].join(' '),
  );
}

if (out) {
  writeFileSync(out, JSON.stringify(toJson(run), null, 2));
  console.log(`\nFull run written to ${out}`);
}
