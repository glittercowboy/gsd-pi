# M001 Roadmap

## Slices

### S01 — Validator framework
- Risk: low
- Depends: none
- Demo: validateArtifact() returns structured ValidationResult for fixture files

### S02 — Cross-reference checks
- Risk: medium
- Depends: S01
- Demo: requirements with dangling milestone references are flagged

## Definition of Done

- All three validators (project, requirements, roadmap) live behind validateArtifact()
- 90%+ test coverage on the validator module
- Deep-mode dispatch rules call validateArtifact before stage gate clears
