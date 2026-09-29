import { describe, expect, it } from "vitest";
import { codeFence, escapeMd, REVIEW_MARKER, reviewFile, reviewMarkdown, reviewMaxRisk } from "../../src/review/review.js";

describe("escapeMd", () => {
  it("neutralizes Markdown, HTML, table pipes and @-mentions from untrusted text", () => {
    const out = escapeMd("migrations/a|b <img src=x onerror=alert(1)> @octocat [x](https://evil) `code` *bold*\nnext");
    for (const bad of ["|", "<", ">", "@", "[", "]", "`", "*", "\n"]) expect(out).not.toContain(bad);
    expect(out).toContain("&#64;octocat"); // renders as "@octocat" but doesn't notify anyone
  });
});

describe("codeFence", () => {
  it("uses a fence longer than any backtick run inside, so SQL can't break out", () => {
    const sql = "SELECT 1; -- ``` closes a normal fence\n-- ```` and so would this\n<img src=x onerror=alert(1)>";
    const block = codeFence(sql);
    expect(block.startsWith("`````sql\n")).toBe(true);
    expect(block.endsWith("\n`````")).toBe(true);
    expect(codeFence("SELECT 1")).toBe("```sql\nSELECT 1\n```");
  });
});

describe("reviewMarkdown", () => {
  it("starts with the marker and summarizes risk; suggests a rewrite for risky DDL", async () => {
    const md = reviewMarkdown([await reviewFile("db/001.sql", "CREATE INDEX i ON accounts (status);")]);
    expect(md.startsWith(`${REVIEW_MARKER}\n## DriftGuard migration review`)).toBe(true);
    expect(md).toContain("| 1 | CREATE INDEX | SHARE on public.accounts | writes | scans table |");
    expect(md).toContain("<summary>Suggested safe rewrite</summary>");
    expect(md).toContain("CREATE INDEX CONCURRENTLY i ON accounts (status);");
  });

  it("omits the rewrite for statements that are already safe", async () => {
    const r = await reviewFile("db/002.sql", "SET lock_timeout = '3s'; CREATE INDEX CONCURRENTLY i ON accounts (status);");
    expect(reviewMaxRisk([r])).toBe("low");
    expect(reviewMarkdown([r])).not.toContain("Suggested safe rewrite");
  });

  it("reports files that don't parse instead of failing the whole review", async () => {
    const r = await reviewFile("db/bad.sql", "ALTER TABLE x ADD COLUM y int");
    expect(r.error).toMatch(/syntax error/);
    expect(reviewMarkdown([r])).toContain("Could not analyze this file: syntax error");
  });

  it("keeps hostile content inert: SQL in a longer fence, identifiers escaped", async () => {
    // The index name (a quoted identifier) carries ``` and HTML into the rewrite script.
    const sql = 'CREATE INDEX "x```<script>alert(1)</script>@octocat" ON accounts (status);';
    const md = reviewMarkdown([await reviewFile("db/evil|<b>.sql", sql)]);
    expect(md).toContain("### db/evil&#124;&#60;b&#62;.sql");
    expect(md).toContain("````sql\n"); // one backtick longer than the ``` in the name
    // Outside the code block, nothing from the SQL is raw.
    const outsideFences = md.split(/^````sql$[\s\S]*?^````$/m).join("");
    expect(outsideFences).not.toMatch(/<script>|@octocat|<b>/);
    expect(md).toContain("<script>alert(1)</script>"); // still shown, but only inside the code block
  });

  it("drops whole file sections to stay under the size limit, never leaving a fence open", async () => {
    const one = await reviewFile("db/x.sql", "CREATE INDEX i ON accounts (status);");
    const md = reviewMarkdown(Array.from({ length: 50 }, (_, i) => ({ ...one, path: `db/${i}.sql` })), { maxChars: 5000 });
    expect(md.length).toBeLessThanOrEqual(5000);
    expect(md).toMatch(/…\d+ more file\(s\) not shown/);
    expect((md.match(/^```/gm) ?? []).length % 2).toBe(0);
  });

  it("says so when no migration files changed", () => {
    expect(reviewMarkdown([])).toContain("No migration files changed.");
  });
});
