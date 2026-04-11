import type { ExtensionAPI } from "@gsd/pi-coding-agent";

export {
  isDepthConfirmationAnswer,
  isDepthVerified,
  isGateQuestionId,
  isQueuePhaseActive,
  setQueuePhaseActive,
  shouldBlockContextWrite,
  shouldBlockPendingGate,
  shouldBlockPendingGateBash,
  shouldBlockQueueExecution,
  setPendingGate,
  clearPendingGate,
  getPendingGate,
} from "./bootstrap/write-gate.js";

export default async function registerExtension(pi: ExtensionAPI) {
  const { registerGsdExtension } = await import("./bootstrap/register-extension.js");
  registerGsdExtension(pi);
}
