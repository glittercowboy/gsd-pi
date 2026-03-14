/**
 * AdvancedPermissionsPanel — 5 toggleable rows + 1 locked row.
 * Pure display/state component — no fetch calls. Caller persists settings.
 */
import { useState } from "react";

export interface PermissionSettings {
  packageInstall: boolean;      // npm, pip, cargo etc. — default: true
  shellBuildCommands: boolean;  // test runners, build scripts — default: true
  gitCommits: boolean;          // automatic per-task checkpoints — default: true
  gitPush: boolean;             // push to remote — default: false
  askBeforeEach: boolean;       // debug mode — default: false
}

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  packageInstall: true,
  shellBuildCommands: true,
  gitCommits: true,
  gitPush: false,
  askBeforeEach: false,
};

interface AdvancedPermissionsPanelProps {
  settings: PermissionSettings;
  onChange: (settings: PermissionSettings) => void;
}

/** Individual toggle row matching SettingsView ToggleRow style but with inline styles for design tokens. */
function PermToggleRow({
  label,
  note,
  checked,
  onChange,
}: {
  label: string;
  note?: string;
  checked: boolean;
  onChange: (val: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          cursor: "pointer",
        }}
      >
        {/* Toggle button */}
        <button
          type="button"
          onClick={() => onChange(!checked)}
          style={{
            position: "relative",
            width: "2.25rem",
            height: "1.25rem",
            borderRadius: "9999px",
            background: checked ? "#5BC8F0" : "#1E2D3D",
            border: "none",
            cursor: "pointer",
            flexShrink: 0,
            transition: "background 0.15s",
          }}
          aria-pressed={checked}
        >
          <span
            style={{
              position: "absolute",
              top: "0.125rem",
              left: checked ? "1.125rem" : "0.125rem",
              width: "1rem",
              height: "1rem",
              borderRadius: "50%",
              background: "#ffffff",
              transition: "left 0.15s",
            }}
          />
        </button>
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: "0.875rem",
            color: "#cbd5e1",
          }}
        >
          {label}
        </span>
      </label>
      {note && (
        <p
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: "0.75rem",
            color: "#64748b",
            margin: "0 0 0 2.75rem",
          }}
        >
          {note}
        </p>
      )}
    </div>
  );
}

/** Locked row — always on, no toggle. */
function LockedRow({ label, note }: { label: string; note?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        {/* Lock icon */}
        <span
          style={{
            width: "2.25rem",
            height: "1.25rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <LockIcon />
        </span>
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: "0.875rem",
            color: "#94a3b8",
            flex: 1,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: "0.75rem",
            color: "#22C55E",
          }}
        >
          Always on
        </span>
      </div>
      {note && (
        <p
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: "0.75rem",
            color: "#64748b",
            margin: "0 0 0 2.75rem",
          }}
        >
          {note}
        </p>
      )}
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="2" y="6" width="10" height="7" rx="1.5" stroke="#22C55E" strokeWidth="1.5" />
      <path d="M4.5 6V4.5a2.5 2.5 0 0 1 5 0V6" stroke="#22C55E" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function AdvancedPermissionsPanel({ settings, onChange }: AdvancedPermissionsPanelProps) {
  const set = <K extends keyof PermissionSettings>(key: K, value: PermissionSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div
      style={{
        background: "#1A2332",
        border: "1px solid #1E2D3D",
        borderRadius: "0.5rem",
        padding: "1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
      }}
    >
      {/* Title */}
      <h3
        style={{
          fontFamily: "Share Tech Mono, monospace",
          fontSize: "0.875rem",
          color: "#e2e8f0",
          margin: 0,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        Advanced permission settings
      </h3>

      {/* Rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
        {/* Locked: file operations inside project */}
        <LockedRow
          label="File operations inside project"
          note="This cannot be disabled."
        />

        <div style={{ height: "1px", background: "#1E2D3D" }} />

        {/* packageInstall */}
        <PermToggleRow
          label="Install packages automatically"
          note="npm, pip, cargo, and similar"
          checked={settings.packageInstall}
          onChange={(val) => set("packageInstall", val)}
        />

        {/* shellBuildCommands */}
        <PermToggleRow
          label="Run shell and build commands"
          note="test runners, build scripts"
          checked={settings.shellBuildCommands}
          onChange={(val) => set("shellBuildCommands", val)}
        />

        {/* gitCommits */}
        <PermToggleRow
          label="Create git checkpoints automatically"
          note="one per task, always rollbackable"
          checked={settings.gitCommits}
          onChange={(val) => set("gitCommits", val)}
        />

        {/* gitPush */}
        <PermToggleRow
          label="Push to remote git"
          note="OFF by default — always requires your action"
          checked={settings.gitPush}
          onChange={(val) => set("gitPush", val)}
        />

        {/* askBeforeEach */}
        <div>
          <PermToggleRow
            label="Ask before each operation"
            checked={settings.askBeforeEach}
            onChange={(val) => set("askBeforeEach", val)}
          />
          {settings.askBeforeEach && (
            <div
              style={{
                marginTop: "0.5rem",
                marginLeft: "2.75rem",
                background: "rgba(245,158,11,0.1)",
                border: "1px solid rgba(245,158,11,0.3)",
                borderRadius: "0.375rem",
                padding: "0.625rem 0.75rem",
              }}
            >
              <p
                style={{
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: "0.75rem",
                  color: "#F59E0B",
                  margin: 0,
                }}
              >
                This will pause GSD after every file operation. Auto mode will not work correctly. Use this for debugging only.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
