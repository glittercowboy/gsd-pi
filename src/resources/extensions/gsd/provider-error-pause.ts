export type ProviderErrorPauseUI = {
  notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
};

export async function pauseAutoForProviderError(
  ui: ProviderErrorPauseUI,
  errorDetail: string,
  pause: () => Promise<void>,
): Promise<void> {
  ui.notify(`Auto-mode paused due to provider error${errorDetail}`, "warning");
  await pause();
}
