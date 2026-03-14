/**
 * TrustDialog — shown once per project on first open.
 * Writes .gsd/.mission-control-trust on confirm.
 * Uses design system colors via inline styles to avoid Tailwind purge risk.
 */
import { useState } from "react";

interface TrustDialogProps {
  gsdDir: string;           // .gsd/ path for trust flag write
  onConfirm: () => void;    // called after trust flag written
  onAdvanced: () => void;   // called when "Advanced permission settings →" clicked
}

export function TrustDialog({ gsdDir, onConfirm, onAdvanced }: TrustDialogProps) {
  const [loading, setLoading] = useState(false);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await fetch("/api/trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: gsdDir }),
      });
      onConfirm();
    } catch {
      // On network error, still proceed — trust flag may not have written,
      // but we don't block the user from building.
      onConfirm();
    } finally {
      setLoading(false);
    }
  };

  return (
    /* Overlay */
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      {/* Dialog card */}
      <div
        style={{
          background: "#131C2B",
          border: "1px solid #1E2D3D",
          borderRadius: "0.75rem",
          padding: "2rem",
          maxWidth: "480px",
          width: "100%",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        {/* Title */}
        <h2
          style={{
            fontFamily: "Share Tech Mono, monospace",
            fontSize: "1.25rem",
            color: "#e2e8f0",
            margin: "0 0 1.5rem 0",
          }}
        >
          Before we start building
        </h2>

        {/* The AI will */}
        <div style={{ marginBottom: "1rem" }}>
          <p
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: "0.75rem",
              color: "#94a3b8",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              margin: "0 0 0.5rem 0",
            }}
          >
            The AI will:
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {([
              ["Work only inside your project folder", "Files outside this folder are never touched."],
              ["Create and edit files automatically", "Your code is written without interruption. You review when each task finishes."],
              ["Install packages when your project needs them", "npm, pip, and similar tools run automatically."],
              ["Save your progress automatically", "Every task creates a checkpoint you can roll back to."],
            ] as const).map(([label, note]) => (
              <li key={label} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                <span style={{ color: "#22C55E", fontFamily: "JetBrains Mono, monospace", fontSize: "0.875rem", flexShrink: 0 }}>✓</span>
                <div>
                  <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "0.875rem", color: "#cbd5e1" }}>{label}</span>
                  <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "0.75rem", color: "#64748b", marginLeft: "0.25rem" }}>— {note}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* The AI will never */}
        <div style={{ marginBottom: "1.5rem" }}>
          <p
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: "0.75rem",
              color: "#94a3b8",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              margin: "0 0 0.5rem 0",
            }}
          >
            The AI will never:
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {([
              "Access files outside your project folder",
              "Push to GitHub without your confirmation",
              "Delete your project or git history",
            ] as const).map((item) => (
              <li key={item} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <span style={{ color: "#EF4444", fontFamily: "JetBrains Mono, monospace", fontSize: "0.875rem", flexShrink: 0 }}>✗</span>
                <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "0.875rem", color: "#cbd5e1" }}>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* CTA */}
        <button
          type="button"
          onClick={handleConfirm}
          disabled={loading}
          style={{
            width: "100%",
            padding: "0.625rem 1rem",
            background: loading ? "rgba(91,200,240,0.6)" : "#5BC8F0",
            color: "#0F1419",
            fontFamily: "Share Tech Mono, monospace",
            fontSize: "0.875rem",
            fontWeight: 600,
            border: "none",
            borderRadius: "0.375rem",
            cursor: loading ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
            marginBottom: "0.75rem",
          }}
        >
          {loading ? (
            <>
              <SpinnerIcon />
              Starting…
            </>
          ) : (
            "I understand, start building"
          )}
        </button>

        {/* Advanced link */}
        <div style={{ textAlign: "center" }}>
          <button
            type="button"
            onClick={onAdvanced}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              fontFamily: "JetBrains Mono, monospace",
              fontSize: "0.75rem",
              color: "#5BC8F0",
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Advanced permission settings →
          </button>
        </div>
      </div>
    </div>
  );
}

/** Inline spinner for loading state. */
function SpinnerIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      style={{ animation: "spin 1s linear infinite" }}
    >
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <circle cx="7" cy="7" r="5" stroke="#0F1419" strokeWidth="2" strokeOpacity="0.3" />
      <path d="M7 2a5 5 0 0 1 5 5" stroke="#0F1419" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
