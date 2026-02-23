// ─────────────────────────────────────────────────────────────
// RunnerLens — HTML Charts Test Suite
// ─────────────────────────────────────────────────────────────

import { sparkline, htmlStatCards, htmlBarChart, htmlTimeline, htmlWaterfall } from '../src/html-charts';

// ── sparkline ───────────────────────────────────────────────

describe('sparkline', () => {
  it('returns empty string for empty input', () => {
    expect(sparkline([])).toBe('');
  });

  it('returns Unicode block characters', () => {
    const s = sparkline([0, 50, 100], 3);
    expect(s).toMatch(/[▁▂▃▄▅▆▇█]{3}/);
  });

  it('maps min to ▁ and max to █', () => {
    const s = sparkline([0, 100], 2);
    expect(s[0]).toBe('▁');
    expect(s[1]).toBe('█');
  });

  it('down-samples long arrays', () => {
    const values = Array.from({ length: 1000 }, (_, i) => i);
    const s = sparkline(values, 20);
    expect(s.length).toBe(20);
  });
});

// ── htmlStatCards ───────────────────────────────────────────

describe('htmlStatCards', () => {
  it('returns empty string for empty items', () => {
    expect(htmlStatCards([])).toBe('');
  });

  it('returns an HTML table', () => {
    const html = htmlStatCards([{ label: 'CPU', value: '45%' }]);
    expect(html).toContain('<table>');
    expect(html).toContain('</table>');
    expect(html).toContain('<td');
  });

  it('contains card values and labels', () => {
    const html = htmlStatCards([
      { label: 'Duration', value: '5m 23s', sub: '40 samples' },
      { label: 'Avg CPU', value: '45%', sub: 'peak 89%' },
    ]);
    expect(html).toContain('5m 23s');
    expect(html).toContain('Duration');
    expect(html).toContain('45%');
    expect(html).toContain('Avg CPU');
    expect(html).toContain('peak 89%');
  });

  it('renders sub-label when provided', () => {
    const html = htmlStatCards([{ label: 'X', value: '1', sub: 'details' }]);
    expect(html).toContain('details');
  });

  it('escapes HTML in values', () => {
    const html = htmlStatCards([{ label: 'X', value: '<script>' }]);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

// ── htmlBarChart ────────────────────────────────────────────

describe('htmlBarChart', () => {
  it('returns empty string for empty items', () => {
    expect(htmlBarChart([])).toBe('');
  });

  it('returns a Markdown table', () => {
    const md = htmlBarChart([{ label: 'Build', value: 120 }]);
    expect(md).toContain('| Step |');
    expect(md).toContain('Build');
  });

  it('creates proportional bars', () => {
    const md = htmlBarChart([
      { label: 'Long', value: 100 },
      { label: 'Short', value: 10 },
    ], { maxWidth: 20 });
    const longBar = md.match(/`(█+)`.*Long|Long.*`(█+)`/)?.[1] ?? md.match(/Long[^`]*`(█+)`/)?.[1] ?? '';
    const shortBar = md.match(/Short[^`]*`(█+)`/)?.[1] ?? '';
    expect(longBar.length).toBeGreaterThan(shortBar.length);
  });

  it('uses custom value formatter', () => {
    const md = htmlBarChart(
      [{ label: 'Step', value: 125 }],
      { formatValue: (v) => `${Math.floor(v / 60)}m ${v % 60}s` },
    );
    expect(md).toContain('2m 5s');
  });

  it('truncates long names', () => {
    const md = htmlBarChart([{ label: 'A very long step name that exceeds the limit completely', value: 10 }]);
    expect(md).toContain('…');
  });
});

// ── htmlTimeline ────────────────────────────────────────────

describe('htmlTimeline', () => {
  it('returns empty string for empty rows', () => {
    expect(htmlTimeline([])).toBe('');
  });

  it('returns a code block with sparklines', () => {
    const md = htmlTimeline([
      { label: 'CPU', values: [10, 50, 90], avg: '50% avg' },
    ]);
    expect(md).toContain('```');
    expect(md).toContain('CPU');
    expect(md).toContain('50% avg');
  });

  it('includes sparkline characters', () => {
    const md = htmlTimeline([
      { label: 'CPU', values: [0, 25, 50, 75, 100], avg: '50%' },
    ]);
    expect(md).toMatch(/[▁▂▃▄▅▆▇█]/);
  });

  it('aligns labels', () => {
    const md = htmlTimeline([
      { label: 'CPU', values: [50], avg: '50%' },
      { label: 'Memory', values: [30], avg: '30%' },
    ]);
    // Memory is longer, so CPU should be padded
    const lines = md.split('\n').filter(l => l.includes('▁') || l.includes('█') || l.includes('▄'));
    if (lines.length === 2) {
      // Both sparkline positions should be at the same column
      const pos0 = lines[0].indexOf('▁') >= 0 ? lines[0].indexOf('▁') : lines[0].indexOf('█');
      const pos1 = lines[1].indexOf('▁') >= 0 ? lines[1].indexOf('▁') : lines[1].indexOf('█');
      expect(Math.abs(pos0 - pos1)).toBeLessThanOrEqual(1);
    }
  });
});

// ── htmlWaterfall ───────────────────────────────────────────

describe('htmlWaterfall', () => {
  it('returns empty string for empty rows', () => {
    expect(htmlWaterfall([])).toBe('');
  });

  it('returns a Markdown table', () => {
    const md = htmlWaterfall([
      { job: 'build', step: 'Checkout', startSec: 0, durationSec: 8 },
    ]);
    expect(md).toContain('| Job |');
    expect(md).toContain('build');
    expect(md).toContain('Checkout');
  });

  it('includes duration labels', () => {
    const md = htmlWaterfall([
      { job: 'build', step: 'Install', startSec: 0, durationSec: 125 },
    ]);
    expect(md).toContain('2m 5s');
  });

  it('positions bars by start time', () => {
    const md = htmlWaterfall([
      { job: 'build', step: 'A', startSec: 0, durationSec: 10 },
      { job: 'test', step: 'B', startSec: 50, durationSec: 10 },
    ], { totalWidth: 20 });
    // Second bar should have leading spaces for offset
    const lines = md.split('\n').filter(l => l.includes('`'));
    expect(lines.length).toBe(2);
    // The first bar starts at position 0, the second at ~position 16
    const bar1 = lines[0].match(/`([^`]+)`/)?.[1] ?? '';
    const bar2 = lines[1].match(/`([^`]+)`/)?.[1] ?? '';
    // Second bar has more leading spaces
    const spaces1 = bar1.match(/^ */)?.[0].length ?? 0;
    const spaces2 = bar2.match(/^ */)?.[0].length ?? 0;
    expect(spaces2).toBeGreaterThan(spaces1);
  });

  it('truncates long step names', () => {
    const md = htmlWaterfall([
      { job: 'j', step: 'A very long step name exceeding limit', startSec: 0, durationSec: 10 },
    ]);
    expect(md).toContain('…');
  });
});
