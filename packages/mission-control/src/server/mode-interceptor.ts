/**
 * mode-interceptor.ts
 *
 * Pure function for parsing Claude stream text for XML mode event markers.
 * Called from pipeline.ts text_delta handler to strip mode tags before
 * forwarding text to the client and emit structured ModeEvent objects.
 *
 * Design: stateful streaming via a buffer parameter — incomplete XML at chunk
 * boundaries is held in remainder and prepended on the next call.
 */

import type { ModeEvent, ReviewResults, QuestionCardPayload } from "./chat-types";

/**
 * Regex to detect dev server URLs in plain Claude Code stdout.
 * Matches: localhost:PORT, 127.0.0.1:PORT, http://localhost:PORT, http://127.0.0.1:PORT
 * Does NOT match non-localhost URLs (github.com, api.example.com, etc.)
 */
const DEV_SERVER_RE = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d+)/g;

/** Ports to exclude from dev_server_detected — Mission Control's own ports */
const EXCLUDED_PORTS = new Set([4200, 4001, 4010]);

export function parseStreamForModeEvents(
  text: string,
  buffer: string
): { events: ModeEvent[]; stripped: string; remainder: string } {
  // Prepend any buffered partial XML from the previous chunk
  const scanText = buffer + text;

  const events: ModeEvent[] = [];
  let workText = scanText;
  let stripped = "";
  let remainder = "";

  // We process the text left-to-right, collecting stripped text between tags
  let cursor = 0;

  while (cursor < workText.length) {
    // Find the next potential XML open tag
    const nextTag = workText.indexOf("<", cursor);

    if (nextTag === -1) {
      // No more tags — everything remaining is plain text
      stripped += workText.slice(cursor);
      cursor = workText.length;
      break;
    }

    // Collect plain text before this tag
    stripped += workText.slice(cursor, nextTag);
    cursor = nextTag;

    // --- Try to match known mode tags ---

    // 1. discuss_mode_start (self-closing): <discuss_mode_start total="N" />
    const discussStartMatch = workText.slice(cursor).match(
      /^<discuss_mode_start\s+total="(\d+)"\s*\/>/
    );
    if (discussStartMatch) {
      events.push({ type: "discuss_mode_start", total: parseInt(discussStartMatch[1], 10) });
      cursor += discussStartMatch[0].length;
      continue;
    }

    // 2. discuss_mode_end (self-closing): <discuss_mode_end />
    const discussEndMatch = workText.slice(cursor).match(/^<discuss_mode_end\s*\/>/);
    if (discussEndMatch) {
      events.push({ type: "discuss_mode_end" });
      cursor += discussEndMatch[0].length;
      continue;
    }

    // 3. decision (self-closing): <decision question_id="..." area="..." answer="..." />
    const decisionMatch = workText.slice(cursor).match(
      /^<decision\s+question_id="([^"]+)"\s+area="([^"]+)"\s+answer="([^"]+)"\s*\/>/
    );
    if (decisionMatch) {
      events.push({
        type: "decision_logged",
        decision: {
          questionId: decisionMatch[1],
          area: decisionMatch[2],
          answer: decisionMatch[3],
        },
      });
      cursor += decisionMatch[0].length;
      continue;
    }

    // 4. question block tag: <question ...>...</question>
    if (workText.slice(cursor).match(/^<question\s/)) {
      const closeTag = "</question>";
      const closeIdx = workText.indexOf(closeTag, cursor);
      if (closeIdx === -1) {
        // Incomplete block — keep from cursor onward as remainder
        remainder = workText.slice(cursor);
        // Don't add to stripped
        cursor = workText.length;
        break;
      }
      const block = workText.slice(cursor, closeIdx + closeTag.length);
      const questionEvent = parseQuestionBlock(block);
      if (questionEvent) events.push(questionEvent);
      cursor = closeIdx + closeTag.length;
      continue;
    }

    // 5. review_mode_start block: <review_mode_start>...</review_mode_start>
    if (workText.slice(cursor).startsWith("<review_mode_start>")) {
      const closeTag = "</review_mode_start>";
      const closeIdx = workText.indexOf(closeTag, cursor);
      if (closeIdx === -1) {
        // Incomplete block — keep from cursor onward as remainder
        remainder = workText.slice(cursor);
        cursor = workText.length;
        break;
      }
      const block = workText.slice(cursor, closeIdx + closeTag.length);
      const reviewEvent = parseReviewBlock(block);
      if (reviewEvent) events.push(reviewEvent);
      cursor = closeIdx + closeTag.length;
      continue;
    }

    // 6. Possible partial open tag — check if it could be a known mode tag that is incomplete
    const tail = workText.slice(cursor);
    if (isPartialModeTag(tail)) {
      // Hold in remainder; strip from stripped output
      remainder = tail;
      cursor = workText.length;
      break;
    }

    // Not a known or partial mode tag — treat '<' as literal text
    stripped += "<";
    cursor += 1;
  }

  // After XML tag processing, scan the stripped text for dev server URL patterns (Pattern 2)
  // Run on stripped (not raw input) so mode tags don't interfere with URL matching
  DEV_SERVER_RE.lastIndex = 0; // Reset stateful regex
  const urlMatches = [...stripped.matchAll(DEV_SERVER_RE)];
  for (const m of urlMatches) {
    const port = parseInt(m[1], 10);
    // Exclude Mission Control's own ports; only accept valid user-space ports (Pitfall 7)
    if (!EXCLUDED_PORTS.has(port) && port > 1023 && port < 65536) {
      events.push({ type: "dev_server_detected", port });
    }
  }

  return { events, stripped, remainder };
}

/**
 * Returns true if tail starts with '<' and could be a partial opening of a known mode tag
 * (i.e., no complete '<' character is matched yet but the prefix matches a known tag start).
 */
function isPartialModeTag(tail: string): boolean {
  const knownPrefixes = [
    "<discuss_mode_start",
    "<discuss_mode_end",
    "<decision",
    "<question",
    "<review_mode_start",
  ];
  for (const prefix of knownPrefixes) {
    // tail is a prefix of a known tag if prefix starts with tail, or tail starts with prefix
    if (prefix.startsWith(tail) && tail.length > 0 && tail !== "<") {
      return true;
    }
  }
  return false;
}

/** Parse a complete <question ...>...</question> block into a ModeEvent. */
function parseQuestionBlock(block: string): ModeEvent | null {
  // Extract opening tag attributes
  const openTagMatch = block.match(/^<question\s+([^>]+)>/);
  if (!openTagMatch) return null;

  const attrsStr = openTagMatch[1];
  const id = extractAttr(attrsStr, "id");
  const area = extractAttr(attrsStr, "area");
  const type = extractAttr(attrsStr, "type") as "multiple_choice" | "free_text";
  const number = parseInt(extractAttr(attrsStr, "number") ?? "1", 10);
  const total = parseInt(extractAttr(attrsStr, "total") ?? "1", 10);

  if (!id || !area || !type) return null;

  // Content between <question ...> and </question>
  const openTagFull = openTagMatch[0];
  const innerContent = block.slice(openTagFull.length, block.lastIndexOf("</question>"));

  // Extract options block if present
  let options: Array<{ value: string; label: string }> | undefined;
  let questionText = innerContent;

  const optionsMatch = innerContent.match(/<options>([\s\S]*?)<\/options>/);
  if (optionsMatch) {
    // Question text is everything before <options>
    questionText = innerContent.slice(0, innerContent.indexOf("<options>"));
    options = parseOptions(optionsMatch[1]);
  }

  const payload: QuestionCardPayload = {
    id,
    area,
    type,
    question: questionText.trim(),
    options,
    questionNumber: number,
    totalQuestions: total,
  };

  return { type: "question_card", question: payload };
}

/** Parse <option value="...">Label</option> entries. */
function parseOptions(optionsBlock: string): Array<{ value: string; label: string }> {
  const results: Array<{ value: string; label: string }> = [];
  const regex = /<option\s+value="([^"]+)">([^<]+)<\/option>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(optionsBlock)) !== null) {
    results.push({ value: match[1], label: match[2] });
  }
  return results;
}

/** Parse a complete <review_mode_start>...</review_mode_start> block into a ModeEvent. */
function parseReviewBlock(block: string): ModeEvent | null {
  const inner = block.slice("<review_mode_start>".length, block.lastIndexOf("</review_mode_start>"));

  // Parse pillars: <pillar name="..." score="...">...</pillar>
  const pillars: ReviewResults["pillars"] = [];
  const pillarRegex = /<pillar\s+name="([^"]+)"\s+score="([^"]+)">([\s\S]*?)<\/pillar>/g;
  let pillarMatch: RegExpExecArray | null;
  while ((pillarMatch = pillarRegex.exec(inner)) !== null) {
    const name = pillarMatch[1];
    const score = parseFloat(pillarMatch[2]);
    const pillarInner = pillarMatch[3];
    const findings: string[] = [];
    const findingRegex = /<finding>([^<]+)<\/finding>/g;
    let findingMatch: RegExpExecArray | null;
    while ((findingMatch = findingRegex.exec(pillarInner)) !== null) {
      findings.push(findingMatch[1]);
    }
    pillars.push({ name, score, findings });
  }

  // Parse fixes: <fix priority="..." pillar="...">text</fix>
  const topFixes: ReviewResults["topFixes"] = [];
  const fixRegex = /<fix\s+priority="([^"]+)"\s+pillar="([^"]+)">([^<]+)<\/fix>/g;
  let fixMatch: RegExpExecArray | null;
  while ((fixMatch = fixRegex.exec(inner)) !== null) {
    topFixes.push({
      priority: parseInt(fixMatch[1], 10),
      pillar: fixMatch[2],
      description: fixMatch[3],
      draftMessage: fixMatch[3],
    });
  }

  const results: ReviewResults = { pillars, topFixes };
  return { type: "review_mode_start", results };
}

/** Extract a named XML attribute value from an attributes string. */
function extractAttr(attrsStr: string, name: string): string | undefined {
  const match = attrsStr.match(new RegExp(`${name}="([^"]+)"`));
  return match?.[1];
}
