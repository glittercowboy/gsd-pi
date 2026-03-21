// Barrel — TUI-dependent exports.
// Import from here when your code needs makeUI, showInterviewRound,
// showNextAction, or showConfirm.  These all have a transitive dependency
// on @gsd/pi-tui and must not be imported from shared/mod.

export { makeUI } from "./ui.js";
export type { UI } from "./ui.js";
export { showInterviewRound } from "./interview-ui.js";
export type { Question, QuestionOption, RoundResult } from "./interview-ui.js";
export { showNextAction } from "./next-action-ui.js";
export { showConfirm } from "./confirm-ui.js";
