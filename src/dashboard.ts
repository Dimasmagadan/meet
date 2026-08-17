import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import type { MeetingStats } from "./types.js";
import { expandPath, loadConfig } from "./storage.js";
import { parseRepoLine, type ParsedRepoLine } from "./git-context.js";

function parseMetaFile(metaPath: string): { title: string; date: Date; mode: string; tags: string[]; repo: ParsedRepoLine | null } | null {
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
    const repo = parseRepoLine(raw);

    return {
      title: titleMatch[1],
      date,
      mode: modeMatch?.[1] ?? "unknown",
      tags,
      repo,
    };
  } catch {
    return null;
  }
}

function parseTranscript(transcriptPath: string): { durationSeconds: number | null; wordCount: number; talkTime: MeetingStats["talkTime"] } {
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

    return { durationSeconds, wordCount, talkTime: parseTalkTimeMarkdown(raw) };
  } catch {
    return { durationSeconds: null, wordCount: 0, talkTime: undefined };
  }
}

// Prefers speakers.json (structured, always present when F1/F2 ran); falls
// back to parsing the "## Talk Time" markdown section for older transcripts
// or when speakers.json didn't survive (manual copy, etc).
function readSpeakersJsonTalkTime(dirPath: string): MeetingStats["talkTime"] {
  const path = join(dirPath, "speakers.json");
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    const speakers: Array<{ label: string; seconds: number }> = data?.talkTime?.speakers ?? [];
    if (speakers.length === 0) return undefined;
    return summarizeTalkTime(speakers);
  } catch {
    return undefined;
  }
}

function parseTalkTimeMarkdown(raw: string): MeetingStats["talkTime"] {
  const section = raw.split(/^## Talk Time$/m)[1];
  if (!section) return undefined;
  const rowRegex = /^- (.+?): (\d+)m (\d+)s \(\d+%\)$/gm;
  const speakers: Array<{ label: string; seconds: number }> = [];
  for (const m of section.matchAll(rowRegex)) {
    speakers.push({ label: m[1], seconds: Number(m[2]) * 60 + Number(m[3]) });
  }
  if (speakers.length === 0) return undefined;
  return summarizeTalkTime(speakers);
}

function summarizeTalkTime(speakers: Array<{ label: string; seconds: number }>): MeetingStats["talkTime"] {
  const me = speakers.find((s) => s.label === "Me")?.seconds ?? 0;
  const others = speakers.filter((s) => s.label !== "Me").reduce((sum, s) => sum + s.seconds, 0);
  const speakerCount = speakers.filter((s) => /^Speaker \d+$/.test(s.label)).length;
  return { me, others, speakerCount };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// JSON.stringify doesn't escape "</script>", so a title/tag containing it
// could close the surrounding <script> tag early and inject arbitrary HTML.
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
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

    const { durationSeconds, wordCount, talkTime: markdownTalkTime } = existsSync(transcriptPath)
      ? parseTranscript(transcriptPath)
      : { durationSeconds: null, wordCount: 0, talkTime: undefined };
    const talkTime = readSpeakersJsonTalkTime(dirPath) ?? markdownTalkTime;

    meetings.push({
      title: meta.title,
      date: meta.date,
      mode: meta.mode,
      tags: meta.tags,
      repo: meta.repo,
      durationSeconds,
      wordCount,
      talkTime,
      dayOfWeek: meta.date.getDay(),
      hour: meta.date.getHours(),
      weekKey: getWeekKey(meta.date),
      monthKey: getMonthKey(meta.date),
    });
  }

  meetings.sort((a, b) => a.date.getTime() - b.date.getTime());
  return meetings;
}

export function generateHTML(meetings: MeetingStats[]): string {
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

  // Overall Me-vs-Others talk ratio, aggregated across meetings with talk-time data
  const withTalkTime = meetings.filter(m => m.talkTime);
  const totalMeSeconds = withTalkTime.reduce((s, m) => s + m.talkTime!.me, 0);
  const totalOthersSeconds = withTalkTime.reduce((s, m) => s + m.talkTime!.others, 0);
  const totalTalkSeconds = totalMeSeconds + totalOthersSeconds;
  const mePercent = totalTalkSeconds > 0 ? Math.round((totalMeSeconds / totalTalkSeconds) * 100) : 0;

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
    const tags = m.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");
    const speakers = m.talkTime ? String(m.talkTime.speakerCount || 1) : "—";
    const repo = m.repo ? `${escapeHtml(m.repo.repoName)}@${escapeHtml(m.repo.headSha)}` : "—";
    return `<tr><td>${dateStr} ${timeStr}</td><td>${escapeHtml(m.title)}</td><td>${dur}</td><td>${m.wordCount}</td><td>${speakers}</td><td>${repo}</td><td>${tags}</td></tr>`;
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
    <div class="sub">${allTags.map(escapeHtml).join(", ") || "none"}</div>
  </div>
  <div class="card">
    <div class="label">Talk Ratio (Me / Others)</div>
    <div class="value">${withTalkTime.length > 0 ? `${mePercent}% / ${100 - mePercent}%` : "—"}</div>
    <div class="sub">${withTalkTime.length} meeting${withTalkTime.length === 1 ? "" : "s"} with talk-time data</div>
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
  <button class="filter-btn active" data-tag="all">All</button>
  ${allTags.map(t => `<button class="filter-btn" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join("\n  ")}
</div>
<div class="chart-box">
  <table id="meetingsTable">
    <thead><tr><th>Date</th><th>Title</th><th>Duration</th><th>Words</th><th>Speakers</th><th>Repo</th><th>Tags</th></tr></thead>
    <tbody>
    ${tableRows}
    </tbody>
  </table>
</div>

<script>
const COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#f778ba', '#79c0ff', '#56d364', '#e3b341', '#ff7b72'];

new Chart(document.getElementById('monthChart'), {
  type: 'bar',
  data: { labels: ${jsonForScript(monthLabels)}, datasets: [{ data: ${jsonForScript(monthValues)}, backgroundColor: '#58a6ff', borderRadius: 4 }] },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#8b949e' }, grid: { display: false } }, y: { ticks: { color: '#8b949e', stepSize: 1 }, grid: { color: '#21262d' } } } }
});

new Chart(document.getElementById('weekChart'), {
  type: 'bar',
  data: { labels: ${jsonForScript(weekLabels)}, datasets: [{ data: ${jsonForScript(weekValues)}, backgroundColor: '#3fb950', borderRadius: 4 }] },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#8b949e', maxRotation: 45 }, grid: { display: false } }, y: { ticks: { color: '#8b949e', stepSize: 1 }, grid: { color: '#21262d' } } } }
});

new Chart(document.getElementById('tagChart'), {
  type: 'doughnut',
  data: { labels: ${jsonForScript(tagLabels)}, datasets: [{ data: ${jsonForScript(tagValues)}, backgroundColor: COLORS.slice(0, ${tagLabels.length}) }] },
  options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#8b949e' } } } }
});

new Chart(document.getElementById('hourChart'), {
  type: 'bar',
  data: { labels: ${jsonForScript(Array.from({length:24},(_,i)=>String(i).padStart(2,'0')))}, datasets: [{ data: ${jsonForScript(hourCounts)}, backgroundColor: '#bc8cff', borderRadius: 4 }] },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#8b949e' }, grid: { display: false } }, y: { ticks: { color: '#8b949e', stepSize: 1 }, grid: { color: '#21262d' } } } }
});

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tag = btn.dataset.tag;
    document.querySelectorAll('#meetingsTable tbody tr').forEach(row => {
      if (tag === 'all') { row.style.display = ''; return; }
      const tags = row.querySelector('td:last-child').textContent;
      row.style.display = tags.includes(tag) ? '' : 'none';
    });
  });
});
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
