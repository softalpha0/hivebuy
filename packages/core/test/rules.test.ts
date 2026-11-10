import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
const rules = read('RULES.md');

describe('RULES.md cites real tests', () => {
  it('every `tests.rs::name` it cites is a Rust test', () => {
    const rust = read('contracts/market/src/tests.rs');
    const cited = [...rules.matchAll(/tests\.rs::(\w+)/g)].map((m) => m[1]!).filter((n) => n !== 'name');
    expect(cited.length).toBeGreaterThan(20);
    for (const name of cited) expect(rust, name).toMatch(new RegExp(`fn ${name}\\(`));
  });

  it('every `clearing.test.ts › name` it cites is a TypeScript test', () => {
    const ts = read('packages/core/test/clearing.test.ts');
    const cited = [...rules.matchAll(/clearing\.test\.ts › ([^`]+)`/g)].map((m) => m[1]!.trim()).filter((n) => n !== 'name');
    expect(cited.length).toBeGreaterThan(5);
    for (const name of cited) expect(ts, name).toContain(name);
  });

  it('uses "forfeit", never "slash"', () => {
    expect(rules.toLowerCase()).not.toContain('slash');
  });
});
