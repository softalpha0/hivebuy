import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/report.js';

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const report = buildReport();

describe('simulation report (README numbers)', () => {
  it('is deterministic', () => {
    expect(buildReport().markdown).toBe(report.markdown);
  });

  it('README quotes the headline exactly', () => {
    expect(readFileSync(root('README.md'), 'utf8')).toContain(report.headline);
  });

  it('docs/RESULTS.md is up to date (run npm run sim -- --report)', () => {
    expect(readFileSync(root('docs/RESULTS.md'), 'utf8')).toBe(report.markdown);
  });

  it('the landing page shows the same two numbers', () => {
    const [more, below] = report.headline.match(/\d+%/g)!;
    const html = readFileSync(root('apps/web/index.html'), 'utf8');
    expect(html).toContain(`<dt>+${more}</dt>`);
    expect(html).toContain(`<dt>${below}</dt>`);
  });
});
