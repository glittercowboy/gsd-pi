import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

describe("forensics journal & activity log awareness", () => {
  const forensicsSrc = readFileSync(join(gsdDir, "forensics.ts"), "utf-8");
  const promptSrc = readFileSync(join(gsdDir, "prompts", "forensics.md"), "utf-8");

  it("scanJournalForForensics reads journal files directly (no full queryJournal load)", () => {
    // Must NOT use queryJournal which loads ALL entries into memory
    assert.ok(
      !forensicsSrc.includes('queryJournal('),
      "forensics.ts must NOT call queryJournal() which loads all entries at once",
    );
    // Must have its own journal scanning with file-level limits
    assert.ok(
      forensicsSrc.includes("scanJournalForForensics"),
      "forensics.ts must have scanJournalForForensics function",
    );
  });

  it("journal scanning limits files parsed to avoid memory bloat", () => {
    assert.ok(
      forensicsSrc.includes("MAX_JOURNAL_RECENT_FILES"),
      "must have MAX_JOURNAL_RECENT_FILES constant to limit parsed files",
    );
    assert.ok(
      forensicsSrc.includes("MAX_JOURNAL_RECENT_EVENTS"),
      "must have MAX_JOURNAL_RECENT_EVENTS constant to limit events extracted",
    );
  });

  it("older journal files are line-counted without full JSON parse", () => {
    assert.ok(
      forensicsSrc.includes("olderEntryCount") || forensicsSrc.includes("olderFiles"),
      "must handle older files separately from recent files",
    );
  });

  it("ForensicReport includes journalSummary field", () => {
    assert.ok(
      forensicsSrc.includes("journalSummary"),
      "ForensicReport must include journalSummary field",
    );
  });

  it("ForensicReport includes activityLogMeta field", () => {
    assert.ok(
      forensicsSrc.includes("activityLogMeta"),
      "ForensicReport must include activityLogMeta field",
    );
  });

  it("buildForensicReport calls scanJournalForForensics", () => {
    assert.ok(
      forensicsSrc.includes("scanJournalForForensics"),
      "buildForensicReport must call scanJournalForForensics",
    );
  });

  it("buildForensicReport calls gatherActivityLogMeta", () => {
    assert.ok(
      forensicsSrc.includes("gatherActivityLogMeta"),
      "buildForensicReport must call gatherActivityLogMeta",
    );
  });

  it("forensics detects journal-based anomalies", () => {
    assert.ok(
      forensicsSrc.includes("detectJournalAnomalies"),
      "forensics.ts must have detectJournalAnomalies function",
    );
    // Check for specific journal anomaly types
    assert.ok(forensicsSrc.includes('"journal-stuck"'), "must detect journal-stuck anomalies");
    assert.ok(forensicsSrc.includes('"journal-guard-block"'), "must detect journal-guard-block anomalies");
    assert.ok(forensicsSrc.includes('"journal-rapid-iterations"'), "must detect journal-rapid-iterations anomalies");
    assert.ok(forensicsSrc.includes('"journal-worktree-failure"'), "must detect journal-worktree-failure anomalies");
  });

  it("formatReportForPrompt includes journal summary section", () => {
    assert.ok(
      forensicsSrc.includes("Journal Summary"),
      "prompt formatter must include a Journal Summary section",
    );
  });

  it("formatReportForPrompt includes activity log overview section", () => {
    assert.ok(
      forensicsSrc.includes("Activity Log Overview"),
      "prompt formatter must include an Activity Log Overview section",
    );
  });

  it("activity log scanning uses tail-read with byte cap (not full file load)", () => {
    // scanActivityLogs uses nativeParseJsonlTail + MAX_JSONL_BYTES for efficient reading
    assert.ok(
      forensicsSrc.includes("nativeParseJsonlTail"),
      "activity log scanning must use nativeParseJsonlTail for tail-reading",
    );
    assert.ok(
      forensicsSrc.includes("MAX_JSONL_BYTES"),
      "activity log scanning must respect MAX_JSONL_BYTES cap",
    );
    // Only reads last 5 files
    assert.ok(
      forensicsSrc.includes("slice(-5)"),
      "activity log scanning must limit to last 5 files",
    );
  });

  it("activity log entries are distilled through extractTrace, not sent raw", () => {
    assert.ok(
      forensicsSrc.includes("extractTrace("),
      "activity log entries must be distilled through extractTrace before reporting",
    );
  });

  it("prompt output is hard-capped at 30KB", () => {
    assert.ok(
      forensicsSrc.includes("MAX_BYTES") && forensicsSrc.includes("30 * 1024"),
      "formatReportForPrompt must have a 30KB hard cap",
    );
    assert.ok(
      forensicsSrc.includes("truncated at 30KB"),
      "prompt must show truncation message when capped",
    );
  });

  it("forensics prompt documents journal format", () => {
    assert.ok(
      promptSrc.includes("### Journal Format"),
      "forensics.md must document the journal format",
    );
    assert.ok(
      promptSrc.includes("flowId"),
      "forensics.md must reference flowId concept",
    );
    assert.ok(
      promptSrc.includes("causedBy"),
      "forensics.md must reference causedBy for causal chains",
    );
  });

  it("forensics prompt includes journal directory in runtime path reference", () => {
    assert.ok(
      promptSrc.includes("journal/"),
      "forensics.md runtime path reference must include journal/",
    );
  });

  it("investigation protocol references journal data", () => {
    assert.ok(
      promptSrc.includes("journal timeline") || promptSrc.includes("journal events"),
      "investigation protocol must reference journal data for tracing",
    );
  });
});
