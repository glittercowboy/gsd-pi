You are resolving a git merge conflict in file `{{filePath}}`.

## Conflict Diff

The file has conflicting changes from two branches. Here are both sides:

{{conflictDiff}}

## Slice Summaries

{{sliceSummaries}}

## Domain Context

{{domainContext}}

## Instructions

1. Analyze both sides of the conflict. Understand the intent behind each change.
2. Produce a **complete** resolved version of the conflicted region — not a partial patch.
3. If both sides make independent, compatible changes, merge them together.
4. If the changes are contradictory, prefer the version that aligns with the slice summaries and domain context.
5. If you are unsure about the semantic correctness of the resolution, set your confidence below 0.5.

## Output Format

Provide the resolved file content between fence markers exactly like this:

~~~resolved
<your complete resolved content here>
~~~

Then provide your confidence score (0.0 to 1.0) on a line by itself:

Confidence: <score>

Finally, write a brief explanation of how you resolved the conflict and why.
