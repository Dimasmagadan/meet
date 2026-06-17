import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import type { MeetingStats } from "./types.js";
import { expandPath, loadConfig } from "./storage.js";

function parseMetaFile(metaPath: string): { title: string; date: Date; mode: string; tags: string[] } | null {
  try {
    const raw = readFileSync(metaPath, "utf-8");
    const titleMatch = raw.match(/^# (.+)$/m);
    const dateMatch = raw.match(/- Date: (\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
    const modeMatch = raw.match(/- Mode: (.+)$/m);
    const tagsMatch = raw.match(/- Tags: (.*)$/m);

    if (!titleMatch || !dateMatch) return null;

    const [, day, month, year, hour, minute] = dateMatch;
    const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
    const tags = tagsMatch?.[1]?.split(",").map(t => t.trim()).filter(Boolean) ?? [];

    return {
      title: titleMatch[1],
      date,
      mode: modeMatch?.[1] ?? "unknown",
      tags,
    };
  } catch {
    return null;
  }
}

function parseTranscript(transcriptPath: string): { durationSeconds: number | null; wordCount: number } {
  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    const timestamps = [...raw.matchAll(/\*\*\[(\d{2}):(\d{2}):(\d{2})\]/g)];

    let durationSeconds: number | null = null;
    if (timestamps.length >= 2) {
      const first = timestamps[0];
      const last = timestamps[timestamps.length - 1];
      const startSec = Number(first[1]) * 3600 + Number(first[2]) * 60 + Number(first[3]);
      const endSec = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
      durationSeconds = endSec - startSec;
    } else if (timestamps.length === 1) {
      durationSeconds = 0;
    }

    const textLines = raw.split("\n").filter(l => l.startsWith("**["));
    const text = textLines.map(l => l.replace(/^\*\*\[\d{2}:\d{2}:\d{2}\]\*\s*\w+:\s*/, "")).join(" ");
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    return { durationSeconds, wordCount };
  } catch {
    return { durationSeconds: null, wordCount: 0 };
  }
}

function getWeekKey(date: Date): string {
  const d = new Date(date);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7) + 1;
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function getMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function collectMeetings(): MeetingStats[] {
  const config = loadConfig();
  const outputDir = expandPath(config.outputDir);

  if (!existsSync(outputDir)) return [];

  const entries = readdirSync(outputDir, { withFileTypes: true });
  const meetings: MeetingStats[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(outputDir, entry.name);
    const metaPath = join(dirPath, "meta.md");
    const transcriptPath = join(dirPath, "transcript.md");

    if (!existsSync(metaPath)) continue;

    const meta = parseMetaFile(metaPath);
    if (!meta) continue;

    const { durationSeconds, wordCount } = existsSync(transcriptPath)
      ? parseTranscript(transcriptPath)
      : { durationSeconds: null, wordCount: 0 };

    meetings.push({
      title: meta.title,
      date: meta.date,
      mode: meta.mode,
      tags: meta.tags,
      durationSeconds,
      wordCount,
      dayOfWeek: meta.date.getDay(),
      hour: meta.date.getHours(),
      weekKey: getWeekKey(meta.date),
      monthKey: getMonthKey(meta.date),
    });
  }

  meetings.sort((a, b) => a.date.getTime() - b.date.getTime());
  return meetings;
}

function generateHTML(meetings: MeetingStats[]): string {
  const total = meetings.length;
  const withDuration = meetings.filter(m => m.durationSeconds !== null);
  const avgDuration = withDuration.length > 0
    ? withDuration.reduce((s, m) => s + m.durationSeconds!, 0) / withDuration.length
    : 0;
  const avgWords = meetings.length > 0
    ? meetings.reduce((s, m) => s + m.wordCount, 0) / meetings.length
    : 0;
  const dateRange = meetings.length > 0
    ? `${meetings[0].date.toLocaleDateString("ru-RU")} — ${meetings[meetings.length - 1].date.toLocaleDateString("ru-RU")}`
    : "—";

  // Tag distribution
  const tagCounts = new Map<string, number>();
  for (const m of meetings) {
    for (const tag of m.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const tagLabels = [...tagCounts.keys()];
  const tagValues = [...tagCounts.values()];

  // Calls per month
  const monthCounts = new Map<string, number>();
  for (const m of meetings) {
    monthCounts.set(m.monthKey, (monthCounts.get(m.monthKey) ?? 0) + 1);
  }
  const monthLabels = [...monthCounts.keys()].sort();
  const monthValues = monthLabels.map(k => monthCounts.get(k)!);

  // Calls per week
  const weekCounts = new Map<string, number>();
  for (const m of meetings) {
    weekCounts.set(m.weekKey, (weekCounts.get(m.weekKey) ?? 0) + 1);
  }
  const weekLabels = [...weekCounts.keys()].sort();
  const weekValues = weekLabels.map(k => weekCounts.get(k)!);

  // Day of week heatmap
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayCounts = new Array(7).fill(0);
  for (const m of meetings) dayCounts[m.dayOfWeek]++;

  // Hour distribution
  const hourCounts = new Array(24).fill(0);
  for (const m of meetings) hourCounts[m.hour]++;

  // Meetings table data
  const tableRows = meetings.slice().reverse().map(m => {
    const dur = m.durationSeconds !== null
      ? `${Math.floor(m.durationSeconds / 60)}m ${m.durationSeconds % 60}s`
      : "—";
    const dateStr = m.date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
    const timeStr = m.date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const tags = m.tags.map(t => `<span class="tag">${t}</span>`).join(" ");
    return `<tr><td>${dateStr} ${timeStr}</td><td>${m.title}</td><td>${dur}</td><td>${m.wordCount}</td><td>${tags}</td></tr>`;
  }).join("\n");

  const allTags = [...tagCounts.keys()].sort();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Meet Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e1e4e8; padding: 24px; }
  h1 { font-size: 24px; margin-bottom: 24px; color: #58a6ff; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; }
  .card .label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { font-size: 28px; font-weight: 600; margin-top: 4px; color: #f0f6fc; }
  .card .sub { font-size: 12px; color: #8b949e; margin-top: 2px; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 24px; margin-bottom: 32px; }
  .chart-box { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; }
  .chart-box h3 { font-size: 14px; color: #8b949e; margin-bottom: 12px; }
  canvas { max-height: 280px; }
  .heatmap { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; margin-top: 8px; }
  .heat-cell { text-align: center; padding: 12px 4px; border-radius: 4px; font-size: 12px; }
  .heat-cell .day { color: #8b949e; margin-bottom: 4px; }
  .heat-cell .count { font-size: 18px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; border-bottom: 2px solid #30363d; color: #8b949e; font-weight: 500; }
  td { padding: 8px 12px; border-bottom: 1px solid #21262d; }
  tr:hover td { background: #161b22; }
  .tag { display: inline-block; background: #1f6feb22; color: #58a6ff; padding: 2px 8px; border-radius: 12px; font-size: 11px; margin: 1px 2px; }
  .filter-bar { margin-bottom: 16px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .filter-btn { background: #21262d; border: 1px solid #30363d; color: #8b949e; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; transition: all 0.15s; }
  .filter-btn:hover, .filter-btn.active { background: #1f6feb33; border-color: #58a6ff; color: #58a6ff; }
  .section-title { font-size: 18px; margin: 32px 0 16px; color: #f0f6fc; }
</style>
</head>
<body>
<h1>Meet Dashboard</h1>

<div class="cards">
  <div class="card">
    <div class="label">Total Calls</div>
    <div class="value">${total}</div>
    <div class="sub">${dateRange}</div>
  </div>
  <div class="card">
    <div class="label">Avg Duration</div>
    <div class="value">${Math.floor(avgDuration / 60)}m</div>
    <div class="sub">${Math.round(avgDuration)}s total avg</div>
  </div>
  <div class="card">
    <div class="label">Avg Words</div>
    <div class="value">${Math.round(avgWords)}</div>
    <div class="sub">per meeting</div>
  </div>
  <div class="card">
    <div class="label">Tags Used</div>
    <div class="value">${tagCounts.size}</div>
    <div class="sub">${allTags.join(", ") || "none"}</div>
  </div>
</div>

<div class="charts">
  <div class="chart-box">
    <h3>Calls per Month</h3>
    <canvas id="monthChart"></canvas>
  </div>
  <div class="chart-box">
    <h3>Calls per Week</h3>
    <canvas id="weekChart"></canvas>
  </div>
  <div class="chart-box">
    <h3>Tag Distribution</h3>
    <canvas id="tagChart"></canvas>
  </div>
  <div class="chart-box">
    <h3>Hour of Day</h3>
    <canvas id="hourChart"></canvas>
  </div>
</div>

<div class="chart-box" style="margin-bottom: 32px;">
  <h3>Day of Week</h3>
  <div class="heatmap">
    ${dayNames.map((name, i) => {
      const max = Math.max(...dayCounts);
      const intensity = max > 0 ? dayCounts[i] / max : 0;
      const bg = `rgba(31, 111, 235, ${0.1 + intensity * 0.6})`;
      return `<div class="heat-cell" style="background:${bg}"><div class="day">${name}</div><div class="count">${dayCounts[i]}</div></div>`;
    }).join("\n    ")}
  </div>
</div>

<div class="section-title">All Meetings</div>
<div class="filter-bar">
  <span style="color:#8b949e; font-size:12px;">Filter by tag:</span>
  <button class="filter-btn active" onclick="filterTable('all')">All</button>
  ${allTags.map(t => `<button class="filter-btn" onclick="filterTable('${t}')">${t}</button>`).join("\n  ")}
</div>
<div class="chart-box">
  <table id="meetingsTable">
    <thead><tr><th>Date</th><th>Title</th><th>Duration</th><th>Words</th><th>Tags</th></tr></thead>
    <tbody>
    ${tableRows}
    </tbody>
  </table>
</div>

<script>
const COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#f778ba', '#79c0ff', '#56d364', '#e3b341', '#ff7b72'];

new Chart(document.getElementById('monthChart'), {
  type: 'bar',
  data: { labels: ${JSON.stringify(monthLabels)}, datasets: [{ data: ${JSON.stringify(monthValues)}, backgroundColor: '#58a6ff', borderRadius: 4 }] },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#8b949e' }, grid: { display: false } }, y: { ticks: { color: '#8b949e', stepSize: 1 }, grid: { color: '#21262d' } } } }
});

new Chart(document.getElementById('weekChart'), {
  type: 'bar',
  data: { labels: ${JSON.stringify(weekLabels)}, datasets: [{ data: ${JSON.stringify(weekValues)}, backgroundColor: '#3fb950', borderRadius: 4 }] },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#8b949e', maxRotation: 45 }, grid: { display: false } }, y: { ticks: { color: '#8b949e', stepSize: 1 }, grid: { color: '#21262d' } } } }
});

new Chart(document.getElementById('tagChart'), {
  type: 'doughnut',
  data: { labels: ${JSON.stringify(tagLabels)}, datasets: [{ data: ${JSON.stringify(tagValues)}, backgroundColor: COLORS.slice(0, ${tagLabels.length}) }] },
  options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#8b949e' } } } }
});

new Chart(document.getElementById('hourChart'), {
  type: 'bar',
  data: { labels: ${JSON.stringify(Array.from({length:24},(_,i)=>String(i).padStart(2,'0')))}, datasets: [{ data: ${JSON.stringify(hourCounts)}, backgroundColor: '#bc8cff', borderRadius: 4 }] },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#8b949e' }, grid: { display: false } }, y: { ticks: { color: '#8b949e', stepSize: 1 }, grid: { color: '#21262d' } } } }
});

function filterTable(tag) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  document.querySelectorAll('#meetingsTable tbody tr').forEach(row => {
    if (tag === 'all') { row.style.display = ''; return; }
    const tags = row.querySelector('td:last-child').textContent;
    row.style.display = tags.includes(tag) ? '' : 'none';
  });
}
</script>
</body>
</html>`;
}

export async function generateDashboard(outputPath?: string): Promise<void> {
  console.log(chalk.cyan("Scanning meetings..."));
  const meetings = collectMeetings();
  console.log(chalk.gray(`Found ${meetings.length} meetings with meta.md`));

  if (meetings.length === 0) {
    console.log(chalk.yellow("No meetings found. Record some meetings first."));
    return;
  }

  const html = generateHTML(meetings);
  const out = expandPath(outputPath ?? "~/Meetings/dashboard.html");
  await writeFile(out, html, "utf-8");
  console.log(chalk.green(`Dashboard generated: ${out}`));
}
