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

  it('returns an HTML table with card structure', () => {
    const html = htmlStatCards([{ label: 'CPU', value: '45%' }]);
    expect(html).toContain('<table');
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

  it('uses dark card background (#161b22)', () => {
    const html = htmlStatCards([{ label: 'CPU', value: '60%' }]);
    expect(html).toContain('bgcolor="#161b22"');
  });

  it('includes bgcolor accent bar at top when color is provided', () => {
    const html = htmlStatCards([{ label: 'CPU', value: '60%', color: '#58a6ff' }]);
    expect(html).toContain('bgcolor="#58a6ff"');
  });

  it('uses default muted color when no color provided', () => {
    const html = htmlStatCards([{ label: 'CPU', value: '60%' }]);
    expect(html).toContain('bgcolor="#8b949e"');
  });

  it('adds gap cells between cards', () => {
    const html = htmlStatCards([
      { label: 'A', value: '1' },
      { label: 'B', value: '2' },
    ]);
    expect(html).toContain('width="8"');
  });

  it('accent bar has height="3"', () => {
    const html = htmlStatCards([{ label: 'X', value: '1', color: '#58a6ff' }]);
    expect(html).toContain('bgcolor="#58a6ff" height="3"');
  });

  it('has border frame around each card', () => {
    const html = htmlStatCards([{ label: 'CPU', value: '60%' }]);
    // Border uses outer table with bgcolor=#30363d and cellspacing=1
    expect(html).toContain('bgcolor="#30363d"');
    expect(html).toContain('cellspacing="1"');
  });

  it('enforces card width of 141px', () => {
    const html = htmlStatCards([{ label: 'CPU', value: '60%' }]);
    expect(html).toContain('width="141"');
  });
});

// ── htmlBarChart ────────────────────────────────────────────

describe('htmlBarChart', () => {
  it('returns empty string for empty items', () => {
    expect(htmlBarChart([])).toBe('');
  });

  it('returns an HTML table with progress bars', () => {
    const html = htmlBarChart([{ label: 'Build', value: 120 }]);
    expect(html).toContain('<table');
    expect(html).toContain('Build');
    expect(html).toContain('bgcolor=');
  });

  it('creates proportional bars', () => {
    const html = htmlBarChart([
      { label: 'Long', value: 100 },
      { label: 'Short', value: 10 },
    ]);
    const longRow = html.split('</tr>').find(r => r.includes('Long'))!;
    const shortRow = html.split('</tr>').find(r => r.includes('Short'))!;
    const longPct = parseInt(longRow.match(/bgcolor="#58a6ff" width="(\d+)%"/)?.[1] ?? '0');
    const shortPct = parseInt(shortRow.match(/bgcolor="#58a6ff" width="(\d+)%"/)?.[1] ?? '0');
    expect(longPct).toBeGreaterThan(shortPct);
  });

  it('uses custom value formatter', () => {
    const html = htmlBarChart(
      [{ label: 'Step', value: 125 }],
      { formatValue: (v) => `${Math.floor(v / 60)}m ${v % 60}s` },
    );
    expect(html).toContain('2m 5s');
  });

  it('truncates long names', () => {
    const html = htmlBarChart([{ label: 'A very long step name that exceeds the limit completely', value: 10 }]);
    expect(html).toContain('\u2026');
  });

  it('uses bar color from theme', () => {
    const html = htmlBarChart([{ label: 'Test', value: 50 }]);
    expect(html).toContain('#58a6ff');  // C.bar
    expect(html).toContain('#21262d');  // C.barBg
  });
});

// ── htmlTimeline ────────────────────────────────────────────

describe('htmlTimeline', () => {
  it('returns empty string for empty rows', () => {
    expect(htmlTimeline([])).toBe('');
  });

  it('returns area chart in a dark card container', () => {
    const html = htmlTimeline([
      { label: 'CPU', values: [10, 50, 90], avg: '50% avg' },
    ]);
    expect(html).toContain('CPU Usage');
    expect(html).toContain('50% avg');
    expect(html).toContain('<table');
    expect(html).toContain('bgcolor="#161b22"');
  });

  it('generates flush vertical bars with proportional heights', () => {
    const html = htmlTimeline([
      { label: 'CPU', values: [0, 50, 100], avg: '50%' },
    ], 3);
    // Should have bgcolor="#58a6ff" bars with different heights
    const barMatches = html.match(/bgcolor="#58a6ff" height="(\d+)"/g) || [];
    expect(barMatches.length).toBe(3);
  });

  it('uses different colors for CPU and Memory', () => {
    const html = htmlTimeline([
      { label: 'CPU', values: [50], avg: '50%' },
      { label: 'Memory', values: [30], avg: '30%' },
    ]);
    expect(html).toContain('#58a6ff');  // CPU blue
    expect(html).toContain('#bc8cff');  // Memory purple
  });

  it('creates separate cards for each metric', () => {
    const html = htmlTimeline([
      { label: 'CPU', values: [50], avg: '50%' },
      { label: 'Memory', values: [30], avg: '30%' },
    ]);
    expect(html).toContain('CPU Usage');
    expect(html).toContain('Memory Usage');
    const cardCount = (html.match(/bgcolor="#161b22"/g) || []).length;
    expect(cardCount).toBe(2);
  });

  it('shows avg in header row next to title', () => {
    const html = htmlTimeline([
      { label: 'CPU', values: [50, 60], avg: '55% avg' },
    ]);
    // Title and avg should be in the same row
    const titleRow = html.split('</tr>').find(r => r.includes('CPU Usage'));
    expect(titleRow).toContain('55% avg');
  });

  it('renders line with subtle fill area below', () => {
    const html = htmlTimeline([
      { label: 'CPU', values: [50, 100], avg: '75%' },
    ], 2);
    // Line is 2px tall
    expect(html).toContain('height="2"');
    // Fill area below the line uses subtle blue fill
    expect(html).toContain('bgcolor="#1d2938"');
  });

  it('uses purple fill for memory charts', () => {
    const html = htmlTimeline([
      { label: 'Memory', values: [50, 100], avg: '75%' },
    ], 2);
    expect(html).toContain('bgcolor="#272638"');
  });
});

// ── htmlWaterfall ───────────────────────────────────────────

describe('htmlWaterfall', () => {
  it('returns empty string for empty rows', () => {
    expect(htmlWaterfall([])).toBe('');
  });

  it('returns an HTML table with dark card background and gantt bars', () => {
    const html = htmlWaterfall([
      { job: 'build', step: 'Checkout', startSec: 0, durationSec: 8 },
    ]);
    expect(html).toContain('<table');
    expect(html).toContain('build');
    expect(html).toContain('Checkout');
    expect(html).toContain('bgcolor=');
    // Card background
    expect(html).toContain('bgcolor="#161b22"');
  });

  it('includes duration labels', () => {
    const html = htmlWaterfall([
      { job: 'build', step: 'Install', startSec: 0, durationSec: 125 },
    ]);
    expect(html).toContain('2m 5s');
  });

  it('assigns different colors per job', () => {
    const html = htmlWaterfall([
      { job: 'build', step: 'A', startSec: 0, durationSec: 10 },
      { job: 'test', step: 'B', startSec: 50, durationSec: 10 },
    ]);
    expect(html).toContain('#58a6ff');  // first job color
    expect(html).toContain('#bc8cff');  // second job color
  });

  it('shows job name only for first step in group', () => {
    const html = htmlWaterfall([
      { job: 'build', step: 'A', startSec: 0, durationSec: 10 },
      { job: 'build', step: 'B', startSec: 10, durationSec: 20 },
      { job: 'test', step: 'C', startSec: 30, durationSec: 10 },
    ]);
    const boldBuild = (html.match(/<strong>build<\/strong>/g) || []).length;
    expect(boldBuild).toBe(1);
    expect(html).toContain('<strong>test</strong>');
  });

  it('adds separator line between job groups', () => {
    const html = htmlWaterfall([
      { job: 'build', step: 'A', startSec: 0, durationSec: 10 },
      { job: 'test', step: 'B', startSec: 50, durationSec: 10 },
    ]);
    // Separator between build and test
    expect(html).toContain('bgcolor="#30363d" height="1"');
  });

  it('truncates long step names', () => {
    const html = htmlWaterfall([
      { job: 'j', step: 'A very long step name exceeding limit', startSec: 0, durationSec: 10 },
    ]);
    expect(html).toContain('\u2026');
  });

  it('positions bars by start time', () => {
    const html = htmlWaterfall([
      { job: 'build', step: 'A', startSec: 0, durationSec: 10 },
      { job: 'test', step: 'B', startSec: 50, durationSec: 10 },
    ]);
    // Second bar should have a spacer cell with a percentage > 0
    const secondRow = html.split('</tr>').find(r => r.includes('test') && r.includes('B'));
    expect(secondRow).toContain('width="83%"'); // 50/60 ≈ 83%
  });

  it('uses barBg color for track background', () => {
    const html = htmlWaterfall([
      { job: 'build', step: 'A', startSec: 0, durationSec: 10 },
    ]);
    expect(html).toContain('bgcolor="#21262d"');
  });
});
