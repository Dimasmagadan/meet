import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { escapeHtml, jsonForScript, generateHTML, parseTranscript } from "./dashboard.js";
import type { MeetingStats } from "./types.js";

describe("escapeHtml", () => {
  it("escapes HTML metacharacters", () => {
    assert.strictEqual(
      escapeHtml(`<img src=x onerror=alert(1)> & "quoted" 'single'`),
      "&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot; &#39;single&#39;",
    );
  });

  it("leaves plain text unchanged", () => {
    assert.strictEqual(escapeHtml("Weekly Standup"), "Weekly Standup");
  });
});

describe("jsonForScript", () => {
  it("escapes </script> so it can't close the surrounding script tag", () => {
    const out = jsonForScript(["</script><script>alert(1)</script>"]);
    assert.ok(!out.includes("</script>"));
    assert.ok(out.includes("\\u003c/script>"));
  });
});

describe("generateHTML XSS safety", () => {
  const baseMeeting: MeetingStats = {
    title: `<img src=x onerror=alert(1)>`,
    date: new Date(2026, 4, 13, 14, 30),
    mode: "full",
    tags: [`</span><script>alert(2)</script>`],
    repo: { repoName: `"><script>alert(3)</script>`, headSha: "abc123", branch: "main" },
    durationSeconds: 60,
    wordCount: 10,
    talkTime: undefined,
    dayOfWeek: 3,
    hour: 14,
    weekKey: "2026-W20",
    monthKey: "2026-05",
  };

  it("HTML-escapes title, tags, and repo instead of injecting them raw", () => {
    const html = generateHTML([baseMeeting]);
    assert.ok(!html.includes("<img src=x onerror=alert(1)>"));
    assert.ok(!html.includes("</span><script>alert(2)</script>"));
    assert.ok(!html.includes(`"><script>alert(3)</script>`));
  });

  it("does not let a tag close the chart-data <script> block early", () => {
    const html = generateHTML([baseMeeting]);
    // Every literal "</script>" in the output must be one of the real
    // closing tags (chart.js src or the inline script), not one smuggled
    // in via jsonForScript(tagLabels).
    const scriptCloseCount = (html.match(/<\/script>/g) || []).length;
    assert.strictEqual(scriptCloseCount, 2);
  });

  it("uses data-tag attributes instead of inline onclick handlers", () => {
    const html = generateHTML([baseMeeting]);
    assert.ok(!html.includes("onclick="));
  });
});

describe("parseTranscript word counts", () => {
  let dir: string;

  it("strips the live speaker label before counting words", () => {
    dir = join(tmpdir(), `meet-dash-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const path = join(dir, "transcript.md");
      writeFileSync(path, "**[14:30:00] Me:** Привет мир\n**[14:30:30] Speaker 1:** Ответ на вопрос\n");
      const { wordCount } = parseTranscript(path);
      // 2 + 3 = 5 words. The label ("Me", "Speaker 1") must not count.
      assert.strictEqual(wordCount, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips the label-less file-import format", () => {
    dir = join(tmpdir(), `meet-dash-imp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const path = join(dir, "transcript.md");
      writeFileSync(path, "**[00:00:05]** Привет мир\n**[00:00:20]** Конечно\n");
      const { wordCount } = parseTranscript(path);
      assert.strictEqual(wordCount, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips a registry display name label", () => {
    dir = join(tmpdir(), `meet-dash-name-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const path = join(dir, "transcript.md");
      writeFileSync(path, "**[14:30:00] Алексей:** Три слова тут\n");
      const { wordCount } = parseTranscript(path);
      assert.strictEqual(wordCount, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
