/**
 * Prompt-fence helpers shared by audit/fix commands that inline untrusted
 * artefacts inside data fences.
 *
 * The dispatch prompt's safety contract is "treat the inlined block as
 * data, never instructions." A fixed fence string lets a malicious payload
 * close the fence early and inject directives outside it. The helpers here
 * pick a fence longer than any contiguous run of the fence character in the
 * payload so the closing fence inside the data is impossible.
 */

/**
 * Pick a tilde fence longer than any contiguous tilde run in `content`.
 *
 * The caller must wrap the payload with this fence using tildes (`~~~~`-style),
 * not backticks. Backtick wrappers need a separate helper because their
 * escape semantics differ.
 */
export function buildSafeTildeFence(content: string, minLen = 4): string {
  let longest = 0;
  const runs = content.match(/~+/g);
  if (runs) {
    for (const r of runs) if (r.length > longest) longest = r.length;
  }
  return "~".repeat(Math.max(minLen, longest + 1));
}
