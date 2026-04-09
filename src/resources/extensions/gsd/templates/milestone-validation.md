---
id: {{milestoneId}}
remediation_round: {{round}}
verdict: pass | needs-remediation | needs-attention
slices_added: []
human_required_items: 0
validated_at: {{date}}
---

# {{milestoneId}}: Milestone Validation

## Success Criteria Audit

<!-- For each success criterion from the roadmap, list the criterion text,
     verdict (MET / NOT MET), and the specific evidence or gap.
     Every criterion must appear here with a definitive verdict. -->

- **Criterion:** {{criterionText}}
  **Verdict:** {{MET or NOT MET}}
  **Evidence:** {{sliceSummary, UATResult, testOutput, or observableBehavior}}

## Deferred Work Inventory

<!-- Every deferred, incomplete, or flagged item found across all slice summaries
     and UAT results. Include the source so a reader can trace back to the original. -->

| Item | Source | Classification | Disposition |
|------|--------|----------------|-------------|
| {{itemDescription}} | {{sliceId or UAT reference}} | {{auto-remediable / human-required / acceptable}} | {{what happens with this item}} |

## Requirement Coverage

<!-- Active requirements from REQUIREMENTS.md that are not yet Validated.
     If no REQUIREMENTS.md exists, write "No requirements tracking active." -->

- **{{requirementId}}**: {{status}} — {{disposition: covered by remediation slice / acceptable gap / needs attention}}

## Verification Class Compliance

<!-- If verification classes were defined during planning, document whether each
     was addressed. Use N/A for classes that were empty or "none" in planning. -->

| Class | Planned | Evidence | Status |
|-------|---------|----------|--------|
| Contract | {{planned_or_none}} | {{evidence_or_none}} | {{MET / NOT MET / N/A}} |
| Integration | {{planned_or_none}} | {{evidence_or_none}} | {{MET / NOT MET / N/A}} |
| Operational | {{planned_or_none}} | {{evidence_or_none}} | {{MET / NOT MET / N/A}} |
| UAT | {{planned_or_none}} | {{evidence_or_none}} | {{MET / NOT MET / N/A}} |

## Remediation Slices

<!-- New slices appended to the roadmap to address auto-remediable gaps.
     Include the full slice definition as written to the roadmap.
     If no slices were added, write "None required." -->

{{remediationSliceDefinitions OR "None required."}}

## Requires Attention

<!-- Items classified as human-required, with enough context for Lex to make a decision.
     Ordered by priority (blocking items first).
     If none, write "None." -->

- **{{itemTitle}}** ({{priority: blocking / non-blocking}})
  Context: {{whatTheItemIs, whereItCameFrom, whyItNeedsHumanInput}}

## Verdict

<!-- One-paragraph summary assessment.
     State the verdict (pass / needs-remediation / needs-attention),
     the number of criteria met vs total, and the key finding
     that determined the verdict. -->

{{verdictSummary}}
