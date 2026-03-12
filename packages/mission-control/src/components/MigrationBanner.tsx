/**
 * MigrationBanner — shown when a v1 project (.planning/) is opened without .gsd/.
 * Prompts the user to run /gsd migrate to upgrade the project to GSD 2 format.
 */

interface MigrationBannerProps {
  onRunMigration: () => void;
  onDismiss: () => void;
}

export function MigrationBanner({ onRunMigration, onDismiss }: MigrationBannerProps) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 text-sm"
      style={{ borderLeft: "3px solid #F59E0B", background: "#131C2B" }}
      role="alert"
    >
      <span className="flex-1 text-slate-200">
        This project uses GSD v1. Run <span className="font-mono text-amber-400">/gsd migrate</span> to upgrade it.
      </span>
      <button
        type="button"
        onClick={onRunMigration}
        className="shrink-0 rounded bg-amber-500 px-3 py-1 text-xs font-medium text-black hover:bg-amber-400 transition-colors"
      >
        Run migration
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-slate-400 hover:text-slate-200 transition-colors text-base leading-none"
      >
        ×
      </button>
    </div>
  );
}
