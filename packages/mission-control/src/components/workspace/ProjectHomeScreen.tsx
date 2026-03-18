/**
 * ProjectHomeScreen — full-screen project grid shown when no project is open.
 *
 * Developer mode: empty state shows "Open Folder" button.
 * Builder mode:  empty state shows brief-taking input + "Create project" button.
 * Grid: non-archived projects; "Show archived" link reveals archived section.
 */
import React, { useEffect, useState } from "react";
import type { RecentProject } from "@/server/fs-types";
import ProjectCard from "./ProjectCard";

interface ProjectHomeScreenProps {
  /** Whether the interface is in Builder mode. */
  builderMode: boolean;
  /** Called when user resumes an existing project. */
  onOpenProject?: (path: string) => void;
  /** Developer mode empty state: open folder picker. */
  onOpenFolder?: () => void;
  /** Builder mode empty state: create a new project by name. */
  onCreateProject?: (name: string) => void;
  /**
   * Optional pre-loaded project list (used in tests and SSR).
   * When omitted the component fetches /api/projects/recent on mount.
   */
  projects?: RecentProject[];
  /** Open a new independent window (Tauri multi-window). */
  onNewWindow?: () => void;
}

// ---------------------------------------------------------------------------
// Styles — inline tokens, GSD design system
// ---------------------------------------------------------------------------

const rootStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#0F1419",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  padding: "48px 24px",
};

const headerStyle: React.CSSProperties = {
  fontFamily: "'Share Tech Mono', monospace",
  fontSize: 20,
  color: "#5BC8F0",
  marginBottom: 32,
  letterSpacing: "0.04em",
};

const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
  gap: 16,
  width: "100%",
  maxWidth: 1200,
};

const emptyStateStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 16,
  marginTop: 64,
  color: "#64748B",
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
};

const openFolderBtnStyle: React.CSSProperties = {
  border: "1px solid #5BC8F0",
  color: "#5BC8F0",
  background: "transparent",
  padding: "8px 20px",
  borderRadius: 4,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
  cursor: "pointer",
};

const createBtnStyle: React.CSSProperties = {
  background: "#5BC8F0",
  color: "#0F1419",
  border: "none",
  padding: "8px 20px",
  borderRadius: 4,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  background: "#131C2B",
  border: "1px solid #1E2D3D",
  borderRadius: 4,
  color: "#E2E8F0",
  padding: "8px 12px",
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
  minWidth: 280,
  outline: "none",
};

const showArchivedLinkStyle: React.CSSProperties = {
  marginTop: 32,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  color: "#5BC8F0",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textDecoration: "underline",
};

const archivedHeadingStyle: React.CSSProperties = {
  fontFamily: "'Share Tech Mono', monospace",
  fontSize: 14,
  color: "#64748B",
  marginTop: 40,
  marginBottom: 12,
  alignSelf: "flex-start",
  maxWidth: 1200,
  width: "100%",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ProjectHomeScreen({
  builderMode,
  onOpenProject,
  onOpenFolder,
  onCreateProject,
  projects: projectsProp,
  onNewWindow,
}: ProjectHomeScreenProps) {
  const [fetchedProjects, setFetchedProjects] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");

  // Use pre-loaded projects if provided, otherwise fetch.
  const allProjects = projectsProp ?? fetchedProjects;

  useEffect(() => {
    // Only fetch when projects are not provided externally.
    if (projectsProp !== undefined) return;

    setLoading(true);
    fetch("/api/projects/recent")
      .then((r) => r.json())
      .then((data: RecentProject[]) => {
        setFetchedProjects(data);
      })
      .catch(() => {
        // Silently fail — empty list rendered.
      })
      .finally(() => setLoading(false));
  }, [projectsProp]);

  function refresh() {
    if (projectsProp !== undefined) return; // controlled mode
    setLoading(true);
    fetch("/api/projects/recent")
      .then((r) => r.json())
      .then((data: RecentProject[]) => setFetchedProjects(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  async function handleRestoreProject(path: string) {
    try {
      await fetch("/api/projects/recent/archive", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, archived: false }),
      });
    } catch {
      // Best effort
    }
    refresh();
  }

  const activeProjects = allProjects.filter((p) => !p.archived);
  const archivedProjects = allProjects.filter((p) => p.archived);
  const hasArchived = archivedProjects.length > 0;

  return (
    <div style={rootStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
        <h1 style={{ ...headerStyle, marginBottom: 0 }}>Projects</h1>
        {onNewWindow && (
          <button
            type="button"
            onClick={onNewWindow}
            style={{
              border: "1px solid #5BC8F0",
              color: "#5BC8F0",
              background: "transparent",
              padding: "4px 12px",
              borderRadius: 4,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              cursor: "pointer",
            }}
            title="Open a new window with independent project state"
          >
            New Window
          </button>
        )}
      </div>

      {loading && (
        <p
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: "#64748B",
          }}
        >
          Loading projects...
        </p>
      )}

      {/* Active projects grid */}
      {activeProjects.length > 0 ? (
        <div style={gridStyle}>
          {activeProjects.map((project) => (
            <ProjectCard
              key={project.path}
              project={project}
              onResume={(path) => onOpenProject?.(path)}
              onRefresh={refresh}
            />
          ))}
        </div>
      ) : (
        !loading && (
          <div style={emptyStateStyle}>
            {builderMode ? (
              /* Builder mode: brief-taking input */
              <>
                <p>What project are we building?</p>
                <input
                  style={inputStyle}
                  type="text"
                  placeholder="What are we building? (project name)"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newProjectName.trim()) {
                      onCreateProject?.(newProjectName.trim());
                    }
                  }}
                />
                <button
                  style={createBtnStyle}
                  onClick={() => {
                    if (newProjectName.trim()) {
                      onCreateProject?.(newProjectName.trim());
                    }
                  }}
                >
                  Create project
                </button>
              </>
            ) : (
              /* Developer mode: open folder */
              <>
                <p>No recent projects found.</p>
                <button style={openFolderBtnStyle} onClick={() => onOpenFolder?.()}>
                  Open Project
                </button>
              </>
            )}
          </div>
        )
      )}

      {/* Show archived toggle */}
      {hasArchived && (
        <button
          style={showArchivedLinkStyle}
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? "Hide archived" : "Show archived"}
        </button>
      )}

      {/* Archived section */}
      {showArchived && hasArchived && (
        <>
          <p style={archivedHeadingStyle}>Archived</p>
          <div style={gridStyle}>
            {archivedProjects.map((project) => (
              <div key={project.path} style={{ position: "relative" }}>
                <ProjectCard
                  project={project}
                  onResume={(path) => onOpenProject?.(path)}
                  onRefresh={refresh}
                />
                <button
                  style={{
                    ...openFolderBtnStyle,
                    marginTop: 8,
                    fontSize: 11,
                  }}
                  onClick={() => handleRestoreProject(project.path)}
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
