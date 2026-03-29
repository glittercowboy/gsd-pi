import type { ExtensionAPI } from "@gsd/pi-coding-agent";

export {
  isDepthVerified,
  isQueuePhaseActive,
  setQueuePhaseActive,
  shouldBlockContextWrite,
  shouldBlockQueueExecution,
} from "./bootstrap/write-gate.js";

export default async function registerExtension(pi: ExtensionAPI) {
  const { registerGsdExtension } = await import("./bootstrap/register-extension.js");
  registerGsdExtension(pi);
}
