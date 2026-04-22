import { getEditorKeybindings, type EditorAction } from "@gsd/pi-tui";

export type Keybinding = EditorAction;
export const getKeybindings = getEditorKeybindings;
