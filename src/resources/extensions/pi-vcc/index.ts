/**
 * pi-vcc — Algorithmic conversation compactor for GSD2
 *
 * No LLM calls — produces structured, transcript-preserving summaries.
 * Inspired by VCC (View-oriented Conversation Compiler) by lllyasviel.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { convertToLlm } from "@gsd/pi-coding-agent";

const GSD_HOME = process.env.GSD_HOME || join(homedir(), ".gsd");
const CONFIG_PATH = join(GSD_HOME, "pi-vcc-config.json");

// ─── Config ────────────────────────────────────────────────────────────────

function loadConfig() {
    try {
        if (!existsSync(CONFIG_PATH)) return {};
        return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
        return {};
    }
}

function dbg(data) {
    if (!loadConfig().debug) return;
    try {
        writeFileSync("/tmp/pi-vcc-debug.json", JSON.stringify(data, null, 2));
    } catch { /* non-fatal */ }
}

// ─── Content Utilities ──────────────────────────────────────────────────────

function clip(text, max = 200) {
    return text ? text.slice(0, max) : "";
}

function nonEmptyLines(text) {
    return text ? text.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

function firstLine(text, max = 200) {
    return clip(text ? text.split("\n")[0] ?? "" : "", max);
}

function textOf(content) {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((p) => p?.type === "text")
        .map((p) => p.text ?? "")
        .join("\n");
}

function sanitize(text) {
    if (!text) return "";
    const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
    const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
    return text
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(ANSI_RE, "")
        .replace(CTRL_RE, "");
}

// ─── Normalized Block Types ────────────────────────────────────────────────

// Types are implicit in JS:
// { kind: "user" | "assistant" | "tool_call" | "tool_result" | "thinking", ... }

function normalizeMessages(messages) {
    const blocks = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const base = { sourceIndex: i };

        if (msg.role === "user") {
            const text = sanitize(textOf(msg.content));
            if (text) blocks.push({ kind: "user", text, ...base });
            // Handle images
            if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part?.type === "image") {
                        blocks.push({ kind: "user", text: `[image: ${part.mimeType}]`, ...base });
                    }
                }
            }
            continue;
        }

        if (msg.role === "toolResult") {
            blocks.push({
                kind: "tool_result",
                name: msg.toolName ?? "unknown",
                text: sanitize(textOf(msg.content)),
                isError: msg.isError ?? false,
                ...base,
            });
            continue;
        }

        if (msg.role === "assistant") {
            if (!msg.content) continue;
            if (typeof msg.content === "string") {
                blocks.push({ kind: "assistant", text: sanitize(msg.content), ...base });
                continue;
            }
            if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part?.type === "text") {
                        blocks.push({ kind: "assistant", text: sanitize(part.text), ...base });
                    } else if (part?.type === "thinking") {
                        blocks.push({ kind: "thinking", text: sanitize(part.thinking), redacted: part.redacted ?? false, ...base });
                    } else if (part?.type === "toolCall") {
                        blocks.push({ kind: "tool_call", name: part.name ?? "unknown", args: part.arguments ?? {}, ...base });
                    }
                }
            }
            continue;
        }

        if (msg.role === "bashExecution") {
            blocks.push({ kind: "tool_result", name: "bash", text: `$ ${msg.command ?? ""}\n${msg.output ?? ""}`, isError: false, ...base });
            continue;
        }
    }
    return blocks;
}

// ─── Noise Filtering ────────────────────────────────────────────────────────

const NOISE_TOOLS = new Set([
    "TodoWrite", "TodoRead", "ToolSearch", "WebSearch",
    "AskUser", "ExitSpecMode", "GenerateDroid",
]);

const XML_WRAPPER_RE = /<(system-reminder|ide_opened_file|command-message|context-window-usage)[^>]*>[\s\S]*?<\/\1>/g;
const NOISE_STRINGS = ["Continue from where you left off.", "No response requested.", "IMPORTANT: TodoWrite was not called yet."];

function filterNoise(blocks) {
    const out = [];
    for (const b of blocks) {
        if (b.kind === "thinking") continue;
        if (b.kind === "tool_call" && NOISE_TOOLS.has(b.name)) continue;
        if (b.kind === "tool_result" && NOISE_TOOLS.has(b.name)) continue;
        if (b.kind === "user") {
            const trimmed = b.text?.trim() ?? "";
            if (NOISE_STRINGS.some((s) => trimmed.includes(s))) continue;
            const cleaned = trimmed.replace(XML_WRAPPER_RE, "").trim();
            if (!cleaned) continue;
            out.push({ ...b, text: cleaned });
            continue;
        }
        out.push(b);
    }
    return out;
}

// ─── Section Extraction ─────────────────────────────────────────────────────

// Goals
const SCOPE_CHANGE_RE = /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;
const TASK_RE = /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i;
const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;

function extractGoals(blocks) {
    const goals = [];
    let latestScopeChange = null;

    for (const b of blocks) {
        if (b.kind !== "user") continue;
        const lines = nonEmptyLines(b.text).filter((l) => l.length > 5 && !NOISE_SHORT_RE.test(l));
        if (lines.length === 0) continue;

        if (goals.length === 0) {
            goals.push(...lines.slice(0, 3));
            continue;
        }

        if (SCOPE_CHANGE_RE.test(b.text)) {
            latestScopeChange = lines.slice(0, 3).map((l) => clip(l, 200));
        } else if (TASK_RE.test(b.text) && lines[0].length > 15) {
            latestScopeChange = lines.slice(0, 2).map((l) => clip(l, 200));
        }
    }

    if (latestScopeChange) {
        goals.push("[Scope change]", ...latestScopeChange);
    }

    return goals.slice(0, 8);
}

// Files
const FILE_READ_TOOLS = new Set(["Read", "read_file", "View"]);
const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "edit", "write", "edit_file", "write_file", "MultiEdit"]);
const FILE_CREATE_TOOLS = new Set(["Write", "write", "write_file"]);

function extractPath(args) {
    if (!args || typeof args !== "object") return null;
    for (const key of ["path", "file_path", "filePath", "file"]) {
        if (typeof args[key] === "string") return args[key];
    }
    return null;
}

function extractFiles(blocks, fileOps) {
    const act = {
        read: new Set(fileOps?.readFiles ?? []),
        modified: new Set(fileOps?.modifiedFiles ?? []),
        created: new Set(fileOps?.createdFiles ?? []),
    };

    for (const b of blocks) {
        if (b.kind !== "tool_call") continue;
        const p = extractPath(b.args);
        if (!p) continue;
        if (FILE_READ_TOOLS.has(b.name)) act.read.add(p);
        if (FILE_WRITE_TOOLS.has(b.name)) act.modified.add(p);
        if (FILE_CREATE_TOOLS.has(b.name)) act.created.add(p);
    }

    return act;
}

// Outstanding Context
const BLOCKER_RE = /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

function extractOutstandingContext(blocks) {
    const items = [];
    const tail = blocks.slice(-20);

    for (const b of tail) {
        if (b.kind === "tool_result" && b.isError) {
            items.push(`[${b.name}] ${firstLine(b.text, 150)}`);
            continue;
        }
        if (b.kind === "assistant" || b.kind === "user") {
            for (const line of nonEmptyLines(b.text)) {
                if (!BLOCKER_RE.test(line)) continue;
                if (line.length < 15) continue;
                const clipped = b.kind === "user" ? `[user] ${clip(line, 150)}` : clip(line, 150);
                if (!items.includes(clipped)) items.push(clipped);
                break;
            }
        }
    }

    return items.slice(0, 5);
}

// Preferences
const PREF_PATTERNS = [
    /\bprefer\b/i, /\bdon'?t want\b/i, /\balways\b/i, /\bnever\b/i,
    /\bplease\s+(use|avoid|keep|make)\b/i, /\bstyle[:\s]/i,
    /\bformat[:\s]/i, /\blanguage[:\s]/i,
];

function extractPreferences(blocks) {
    const prefs = [];
    for (const b of blocks) {
        if (b.kind !== "user") continue;
        for (const line of nonEmptyLines(b.text)) {
            if (line.length < 5) continue;
            if (PREF_PATTERNS.some((p) => p.test(line))) {
                prefs.push(clip(line, 200));
            }
        }
    }
    return [...new Set(prefs)].slice(0, 10);
}

// ─── Brief Transcript ───────────────────────────────────────────────────────

const TRUNCATE_USER = 256;
const TRUNCATE_ASSISTANT = 128;
const TOK_RE = /[a-zA-Z]+|[0-9]+|[^\sa-zA-Z0-9]|\s+/g;
const SENSITIVE_RE = /(?:sshpass\s+-p\s*'[^']*'|sshpass\s+-p\s*"[^"]*"|sshpass\s+-p\s*\S+|password[=:]\s*\S+|api[_-]?key[=:]\s*\S+|secret[=:]\s*\S+|token[=:]\s*[A-Za-z0-9_\-\.]{8,}|-i\s+\S+\.pem\b)/gi;

function truncateTokens(text, limit) {
    const flat = text.replace(/\s+/g, " ").trim();
    const matches = flat.match(TOK_RE);
    if (!matches) return flat;
    let count = 0;
    let cut = matches.length;
    for (let i = 0; i < matches.length; i++) {
        if (matches[i].trim()) {
            count++;
            if (count > limit) { cut = i; break; }
        }
    }
    if (cut >= matches.length) return flat;
    return matches.slice(0, cut).join("") + "...(truncated)";
}

function redact(text) {
    return text.replace(SENSITIVE_RE, (m) => {
        const prefix = m.split(/[=:\s]+/)[0];
        return `${prefix} [REDACTED]`;
    });
}

function toolOneLiner(name, args) {
    const path = extractPath(args);
    if (path) return `* ${name} "${path}"`;
    if (name === "bash" || name === "Bash") {
        const cmd = (args?.command ?? args?.description ?? "") + "";
        if (cmd.length > 60) return `* ${name} "${redact(cmd.slice(0, 57))}..."`;
        return `* ${name} "${redact(cmd)}"`;
    }
    if (typeof args?.query === "string") return `* ${name} "${clip(args.query, 60)}"`;
    return `* ${name}`;
}

function compileBrief(blocks) {
    const sections = [];
    let lastHeader = "";

    const push = (header, line) => {
        if (header === lastHeader && sections.length > 0) {
            sections[sections.length - 1].lines.push(line);
            return;
        }
        sections.push({ header, lines: [line] });
        lastHeader = header;
    };

    for (const b of blocks) {
        switch (b.kind) {
            case "user": {
                if (!b.text?.trim()) break;
                const text = truncateTokens(b.text, TRUNCATE_USER);
                const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
                push("[user]", text + ref);
                lastHeader = "[user]";
                break;
            }
            case "assistant": {
                const text = truncateTokens(b.text || "", TRUNCATE_ASSISTANT);
                if (text) {
                    const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
                    push("[assistant]", text + ref);
                }
                break;
            }
            case "tool_call": {
                const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
                push("[assistant]", toolOneLiner(b.name, b.args) + ref);
                break;
            }
            case "tool_result": {
                if (b.isError) {
                    const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";
                    const header = `[tool_error] ${b.name}${ref}`;
                    push(header, firstLine(b.text, 150));
                    lastHeader = header;
                }
                break;
            }
        }
    }

    const out = [];
    for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        if (i > 0) {
            const prev = sections[i - 1];
            const prevIsTools = prev.header === "[assistant]" && prev.lines.every((l) => l.startsWith("* "));
            const curIsTools = sec.header === "[assistant]" && sec.lines.every((l) => l.startsWith("* "));
            if (!(prevIsTools && curIsTools)) out.push("");
        }
        out.push(sec.header);
        for (const line of sec.lines) out.push(line);
    }

    return out.join("\n");
}

// ─── Format Summary ─────────────────────────────────────────────────────────

const SEPARATOR = "\n\n---\n\n";
const BRIEF_MAX_LINES = 120;

function section(title, items) {
    if (!items?.length) return "";
    return `[${title}]\n${items.map((i) => `- ${i}`).join("\n")}`;
}

function capBrief(text) {
    const lines = text.split("\n");
    if (lines.length <= BRIEF_MAX_LINES) return text;
    const omitted = lines.length - BRIEF_MAX_LINES;
    const kept = lines.slice(-BRIEF_MAX_LINES);
    const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
    const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
    return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
}

function formatSummary(data) {
    const headerParts = [
        section("Session Goal", data.sessionGoal),
        section("Files And Changes", data.filesAndChanges),
        section("Outstanding Context", data.outstandingContext),
        section("User Preferences", data.userPreferences),
    ].filter(Boolean);

    const parts = [];
    if (headerParts.length > 0) parts.push(headerParts.join("\n\n"));
    if (data.briefTranscript) parts.push(capBrief(data.briefTranscript));

    return parts.join(SEPARATOR);
}

// ─── Merge Previous Summary ────────────────────────────────────────────────

const HEADER_NAMES = ["Session Goal", "Files And Changes", "Outstanding Context", "User Preferences"];

function sectionOf(text, header) {
    const tag = `[${header}]`;
    const start = text.indexOf(tag);
    if (start < 0) return "";
    const after = text.slice(start);
    const nextSection = HEADER_NAMES.filter((h) => h !== header).map((h) => after.indexOf(`[${h}]`)).filter((n) => n > 0);
    const nextSep = after.indexOf(SEPARATOR);
    const candidates = [...nextSection, ...(nextSep > 0 ? [nextSep] : [])].sort((a, b) => a - b);
    const end = candidates[0];
    return (end ? after.slice(0, end) : after).trim();
}

function briefOf(text) {
    const idx = text.indexOf(SEPARATOR);
    if (idx < 0) return "";
    return text.slice(idx + SEPARATOR.length).trim();
}

function mergeHeaderSection(header, prev, fresh) {
    if (header === "Outstanding Context") return fresh;
    if (!prev) return fresh;
    if (!fresh) return prev;
    const prevLines = prev.split("\n").filter((l) => l.startsWith("- "));
    const freshLines = fresh.split("\n").filter((l) => l.startsWith("- "));
    const combined = [...new Set([...prevLines, ...freshLines])];
    if (combined.length === 0) return "";
    return `[${header}]\n${combined.join("\n")}`;
}

function mergePrevious(prev, fresh) {
    const headers = HEADER_NAMES.map((h) => mergeHeaderSection(h, sectionOf(prev, h), sectionOf(fresh, h))).filter(Boolean);
    const mergedBrief = capBrief((briefOf(prev) || "") + "\n\n" + (briefOf(fresh) || ""));
    const parts = [];
    if (headers.length > 0) parts.push(headers.join("\n\n"));
    if (mergedBrief) parts.push(mergedBrief);
    return parts.join(SEPARATOR);
}

// ─── Main Compile Function ─────────────────────────────────────────────────

function compile(input) {
    const blocks = filterNoise(normalizeMessages(input.messages));
    const fileAct = extractFiles(blocks, input.fileOps);

    const data = {
        sessionGoal: extractGoals(blocks),
        outstandingContext: extractOutstandingContext(blocks),
        filesAndChanges: formatFileActivity(fileAct),
        userPreferences: extractPreferences(blocks),
        briefTranscript: compileBrief(blocks),
    };

    const fresh = formatSummary(data);
    const merged = input.previousSummary ? mergePrevious(input.previousSummary, fresh) : fresh;
    return redact(merged);
}

function formatFileActivity(act) {
    const lines = [];
    const cap = (set, limit) => {
        const arr = [...set];
        if (arr.length <= limit) return arr.join(", ");
        return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
    };
    if (act.modified.size > 0) lines.push(`Modified: ${cap(act.modified, 10)}`);
    if (act.created.size > 0) lines.push(`Created: ${cap(act.created, 10)}`);
    if (act.read.size > 0) lines.push(`Read: ${cap(act.read, 10)}`);
    return lines;
}

// ─── Compaction Hook ────────────────────────────────────────────────────────

function previewContent(content) {
    if (typeof content === "string") return content.slice(0, 300);
    if (Array.isArray(content)) {
        return content
            .map((c) => {
                if (c?.type === "text") return c.text ?? "";
                if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
                if (c?.type === "thinking") return "[thinking]";
                if (c?.type === "image") return `[image:${c.mimeType}]`;
                return `[${c?.type ?? "unknown"}]`;
            })
            .join("\n")
            .slice(0, 300);
    }
    return "";
}

function buildOwnCut(branchEntries) {
    let lastKeptId = undefined;
    for (let i = branchEntries.length - 1; i >= 0; i--) {
        if (branchEntries[i].type === "compaction") {
            lastKeptId = branchEntries[i].firstKeptEntryId;
            break;
        }
    }

    const liveMessages = [];
    let foundKept = !lastKeptId;
    for (const e of branchEntries) {
        if (!foundKept && e.id === lastKeptId) foundKept = true;
        if (!foundKept) continue;
        if (e.type === "compaction") continue;
        if (e.type === "message" && e.message) {
            liveMessages.push({ entry: e, message: e.message });
        }
    }

    if (liveMessages.length <= 2) return null;

    let cutIdx = liveMessages.length - 1;
    while (cutIdx > 0 && liveMessages[cutIdx].message.role !== "user") cutIdx--;
    if (cutIdx <= 0) return null;

    return {
        messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
        firstKeptEntryId: liveMessages[cutIdx].entry.id,
    };
}

function registerBeforeCompactHook(pi) {
    pi.on("session_before_compact", async (event) => {
        const { preparation, branchEntries } = event;

        const ownCut = buildOwnCut(branchEntries);
        if (!ownCut) return { cancel: true };

        const agentMessages = ownCut.messages;
        const firstKeptEntryId = ownCut.firstKeptEntryId;

        // Normalize messages using convertToLlm (imported at top)
        const messages = convertToLlm(agentMessages);

        const summary = compile({
            messages,
            previousSummary: preparation.previousSummary,
            fileOps: {
                readFiles: [...(preparation.fileOps?.read || [])],
                modifiedFiles: [...(preparation.fileOps?.written || []), ...(preparation.fileOps?.edited || [])],
            },
        });

        dbg({
            usedOwnCut: true,
            messagesToSummarize: agentMessages.length,
            firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            summaryLength: summary.length,
            sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
        });

        const sections = [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]);

        return {
            compaction: {
                summary,
                details: {
                    compactor: "pi-vcc",
                    version: 1,
                    sections,
                    sourceMessageCount: agentMessages.length,
                    previousSummaryUsed: Boolean(preparation.previousSummary),
                },
                tokensBefore: preparation.tokensBefore,
                firstKeptEntryId,
            },
        };
    });
}

// ─── Manual Compact Command ────────────────────────────────────────────────

function registerPiVccCommand(pi) {
    pi.registerCommand("pi-vcc", {
        description: "Compact conversation with pi-vcc structured summary",
        handler: async (_args, ctx) => {
            ctx.compact({
                onComplete: () => ctx.ui.notify("Compacted with pi-vcc", "info"),
                onError: (err) => {
                    if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
                        ctx.ui.notify("Nothing to compact", "info");
                    } else {
                        ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
                    }
                },
            });
        },
    });
}

// ─── Recall Tool ────────────────────────────────────────────────────────────

const DEFAULT_RECENT = 25;
const MAX_RESULTS = 50;
const STOPWORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "of", "in", "to", "for",
    "with", "on", "at", "from", "by", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "out", "off", "over",
    "under", "again", "further", "then", "once", "here", "there", "when",
    "where", "why", "how", "all", "both", "each", "few", "more", "most",
    "other", "some", "such", "no", "nor", "not", "only", "own", "same",
    "so", "than", "too", "very", "just", "about", "it", "its", "that",
    "this", "what", "which", "who", "whom", "these", "those",
]);

function loadAllMessages(sessionFile, full) {
    const content = readFileSync(sessionFile, "utf-8");
    const entries = [];
    for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }
    const messageEntries = entries.filter((e) => e.type === "message" && e.message);
    const rendered = messageEntries.map((e, i) => renderMessage(e.message, i, full));
    const rawMessages = messageEntries.map((e) => e.message);
    return { rendered, rawMessages };
}

function renderMessage(msg, index, full) {
    if (msg.role === "user") {
        return { index, role: "user", summary: full ? textOf(msg.content) : clip(textOf(msg.content), 300) };
    }
    if (msg.role === "toolResult") {
        const prefix = msg.isError ? "ERROR " : "";
        const text = full ? textOf(msg.content) : clip(textOf(msg.content), 200);
        return { index, role: "tool_result", summary: `${prefix}[${msg.toolName}] ${text}` };
    }
    if (msg.role === "bashExecution") {
        const text = full ? `$ ${msg.command ?? ""}\n${msg.output ?? ""}` : clip(`$ ${msg.command ?? ""}\n${msg.output ?? ""}`, 300);
        return { index, role: "bash", summary: text };
    }
    const text = full ? textOf(msg.content) : clip(textOf(msg.content), 300);
    const tools = Array.isArray(msg.content)
        ? msg.content.filter((c) => c?.type === "toolCall").map((c) => `${c.name}(${extractPath(c.arguments) ?? ""})`).join(", ")
        : "";
    const files = Array.isArray(msg.content)
        ? msg.content.filter((c) => c?.type === "toolCall").map((c) => extractPath(c.arguments)).filter(Boolean)
        : [];
    const summary = tools ? `${tools}\n${text}` : text;
    return { index, role: "assistant", summary, ...(files.length > 0 && { files }) };
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeRegex(pattern) {
    try { return new RegExp(pattern, "i"); }
    catch { return new RegExp(escapeRegex(pattern), "i"); }
}

function looksLikeRegex(query) {
    return /[|*+?{}()[\]\\^$.]/.test(query);
}

function fullText(msg) {
    if (msg.role === "bashExecution") return `${msg.command ?? ""} ${msg.output ?? ""}`;
    return textOf(msg.content);
}

function countMatches(hay, terms) {
    let count = 0;
    for (const t of terms) { if (safeRegex(t).test(hay)) count++; }
    return count;
}

function lineSnippet(text, regex, contextLines = 2) {
    const lines = text.split("\n");
    let matchIdx = lines.findIndex((l) => regex.test(l));
    if (matchIdx < 0) return undefined;
    const start = Math.max(0, matchIdx - contextLines);
    const end = Math.min(lines.length, matchIdx + contextLines + 1);
    const parts = [];
    if (start > 0) parts.push(`...(${start} lines above)`);
    parts.push(...lines.slice(start, end));
    if (end < lines.length) parts.push(`...(${lines.length - end} lines below)`);
    return parts.join("\n");
}

function searchEntries(entries, messages, query) {
    if (!query?.trim()) return entries;
    const rawQuery = query.trim();

    if (looksLikeRegex(rawQuery)) {
        const regex = safeRegex(rawQuery);
        return entries
            .map((e, i) => ({ e, msg: messages[i] }))
            .filter(({ e, msg }) => {
                const text = msg ? fullText(msg) : e.summary;
                const hay = `${e.role} ${text} ${(e.files || []).join(" ")}`;
                return regex.test(hay);
            })
            .map(({ e, msg }) => {
                const text = msg ? fullText(msg) : e.summary;
                return { ...e, snippet: lineSnippet(text, regex), matchCount: 1 };
            });
    }

    const rawTerms = rawQuery.split(/\s+/);
    const terms = rawTerms.filter((t) => !STOPWORDS.has(t.toLowerCase()) && t.length > 1);
    const effectiveTerms = terms.length > 0 ? terms : rawTerms;
    const snipRe = safeRegex(effectiveTerms.join("|"));
    const minMatch = effectiveTerms.length <= 3 ? 1 : Math.ceil(effectiveTerms.length * 0.4);

    return entries
        .map((e, i) => ({ e, msg: messages[i] }))
        .filter(({ e, msg }) => {
            const text = msg ? fullText(msg) : e.summary;
            const hay = `${e.role} ${text} ${(e.files || []).join(" ")}`;
            return countMatches(hay, effectiveTerms) >= minMatch;
        })
        .map(({ e, msg }) => {
            const text = msg ? fullText(msg) : e.summary;
            const mc = countMatches(`${e.role} ${text} ${(e.files || []).join(" ")}`, effectiveTerms);
            return { ...e, snippet: lineSnippet(text, snipRe), matchCount: mc };
        })
        .sort((a, b) => (b.matchCount || 0) - (a.matchCount || 0));
}

function formatRecallOutput(entries, query) {
    if (!entries.length) return query ? `No matches for "${query}" in session history.` : "No entries in session history.";
    const header = query ? `Found ${entries.length} matches for "${query}":` : `Session history (${entries.length} entries):`;
    const lines = entries.map((e) => {
        const fileSuffix = e.files?.length ? ` files:[${e.files.join(", ")}]` : "";
        const body = query && e.snippet ? e.snippet : e.summary;
        return `#${e.index} [${e.role}]${fileSuffix} ${body}`;
    });
    return `${header}\n\n${lines.join("\n\n")}`;
}

function registerRecallTool(pi) {
    pi.registerTool({
        name: "vcc_recall",
        description:
            "Search full conversation history in this session, including before compaction. " +
            "Use without query to see recent brief history. " +
            "Use with query to search all history. Query supports regex (e.g. 'hook|inject', 'fail.*build'). " +
            "Multi-word queries use OR logic ranked by relevance.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search terms or regex pattern. Multi-word = OR ranked by relevance." },
                expand: { type: "array", items: { type: "number" }, description: "Entry indices to expand to full content" },
            },
            additionalProperties: false,
        },
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const sessionFile = ctx.sessionManager?.getSessionFile?.();
            if (!sessionFile) {
                return { content: [{ type: "text", text: "No session file available." }] };
            }

            const expandSet = new Set(params.expand ?? []);
            if (expandSet.size > 0 && !params.query) {
                const { rendered } = loadAllMessages(sessionFile, true);
                const expanded = rendered.filter((m) => expandSet.has(m.index));
                if (!expanded.length) return { content: [{ type: "text", text: `No entries for indices: ${[...expandSet].join(", ")}` }] };
                return { content: [{ type: "text", text: formatRecallOutput(expanded) }] };
            }

            const { rendered, rawMessages } = loadAllMessages(sessionFile, false);
            const results = params.query?.trim()
                ? searchEntries(rendered, rawMessages, params.query).slice(0, MAX_RESULTS)
                : rendered.slice(-DEFAULT_RECENT);
            return { content: [{ type: "text", text: formatRecallOutput(results, params.query) }] };
        },
    });
}

// ─── Main Export ───────────────────────────────────────────────────────────

export default function piVcc(pi) {
    registerBeforeCompactHook(pi);
    registerPiVccCommand(pi);
    registerRecallTool(pi);
}