import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import createSlashCommand from "./create-slash-command.js";
import createExtension from "./create-extension.js";
import auditCommand from "./audit.js";
import clearCommand from "./clear.js";
import commandPicker from "./command-picker.js";

export default function slashCommands(pi: ExtensionAPI) {
  createSlashCommand(pi);
  createExtension(pi);
  auditCommand(pi);
  clearCommand(pi);
  commandPicker(pi);
}
