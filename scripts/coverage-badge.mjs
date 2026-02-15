import fs from 'fs';
import path from 'path';

const summaryPath = path.resolve('coverage', 'coverage-summary.json');
const outputPath = path.resolve('coverage', 'coverage-badge.json');

const raw = fs.readFileSync(summaryPath, 'utf8');
const summary = JSON.parse(raw);

const pct = summary?.total?.lines?.pct;
if (typeof pct !== 'number') {
  throw new Error('Unable to read total line coverage from coverage-summary.json');
}

const rounded = Math.round(pct * 10) / 10;

let color = 'red';
if (pct >= 90) color = 'brightgreen';
else if (pct >= 80) color = 'green';
else if (pct >= 70) color = 'yellowgreen';
else if (pct >= 60) color = 'yellow';
else if (pct >= 50) color = 'orange';

const badge = {
  schemaVersion: 1,
  label: 'coverage',
  message: `${rounded}%`,
  color,
};

fs.writeFileSync(outputPath, JSON.stringify(badge));
