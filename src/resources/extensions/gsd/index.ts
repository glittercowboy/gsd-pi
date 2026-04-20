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
  // Always register the core /gsd command first, in isolation.
  // This ensures /gsd is available even if the full bootstrap (shortcuts,
  // tools, hooks) fails — e.g. due to a Windows-specific import error.
  const { registerGSDCommand } = await import("./commands/index.js");
  registerGSDCommand(pi);

  // Full setup (shortcuts, tools, hooks) in a separate try/catch so that
  // any platform-specific load failure doesn't take out the core command.
  try {
    const { registerGsdExtension } = await import("./bootstrap/register-extension.js");
    registerGsdExtension(pi);
  } catch (err) {
    const { logWarning } = await import("./workflow-logger.js");
    logWarning(
      "bootstrap",
      `Extension setup partially failed — /gsd commands are available but shortcuts/tools may be missing: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
