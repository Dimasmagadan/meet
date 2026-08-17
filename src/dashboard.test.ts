import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, jsonForScript, generateHTML } from "./dashboard.js";
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
