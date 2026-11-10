import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/report.js';

const root = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
// Windows checkouts may use CRLF; compare content, not line endings.
const read = (rel: string) => readFileSync(root(rel), 'utf8').replace(/\r\n/g, '\n');
const report = buildReport();

describe('simulation report (README numbers)', () => {
  it('is deterministic', () => {
    expect(buildReport().markdown).toBe(report.markdown);
  });

  it('README quotes the headline exactly', () => {
    expect(read('README.md')).toContain(report.headline);
  });

  it('docs/RESULTS.md is up to date (run npm run sim -- --report)', () => {
    expect(read('docs/RESULTS.md')).toBe(report.markdown);
  });

  it('the landing page shows the same two numbers', () => {
    const [more, below] = report.headline.match(/\d+%/g)!;
    const html = read('apps/web/index.html');
    expect(html).toContain(`<dt>+${more}</dt>`);
    expect(html).toContain(`<dt>${below}</dt>`);
  });
});
