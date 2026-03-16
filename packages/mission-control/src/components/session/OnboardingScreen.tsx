/**
 * OnboardingScreen — full-screen welcome for new projects.
 *
 * Shows LogoAnimation at size="lg", then fades in welcome text
 * and action buttons after animation completes.
 *
 * "New Project" — inline name + location input → calls onNewProject(name, location)
 * "Open Project" — opens the folder picker modal
 */
import { useState, useEffect } from "react";
import { LogoAnimation } from "@/components/session/LogoAnimation";

interface OnboardingScreenProps {
  onOpenProject: () => void;
  onNewProject: (name: string, location: string) => void;
}

interface NamingFormProps {
  onCancel: () => void;
  onCreate: (name: string, location: string) => void;
}

function NamingForm({ onCancel, onCreate }: NamingFormProps) {
  const [projectName, setProjectName] = useState("");
  const [location, setLocation] = useState("");

  // Load default workspace path
  useEffect(() => {
    fetch("/api/workspace/path")
      .then((r) => r.json())
      .then((d) => { if (d.path) setLocation(d.path); })
      .catch(() => {});
  }, []);

  function handleCreate() {
    const name = projectName.trim();
    const loc = location.trim();
    if (!name || !loc) return;
    onCreate(name, loc);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleCreate();
    if (e.key === "Escape") onCancel();
  }

  const canCreate = !!projectName.trim() && !!location.trim();

  return (
    <div className="mt-4 flex w-80 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-slate-500">Project name</label>
        <input
          autoFocus
          type="text"
          placeholder="my-project"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          onKeyDown={handleKeyDown}
          className="rounded-md border border-navy-600 bg-navy-700 px-3 py-2 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-cyan-accent/60"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-slate-500">Location</label>
        <input
          type="text"
          placeholder="Path where project folder will be created"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          onKeyDown={handleKeyDown}
          className="rounded-md border border-navy-600 bg-navy-700 px-3 py-2 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-cyan-accent/60"
        />
        {canCreate && (
          <p className="truncate text-xs text-slate-500">
            Will create: {location.replace(/\\/g, "/")}/{projectName.trim()}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="rounded-md bg-navy-700 px-4 py-2 text-sm text-slate-400 transition-colors hover:bg-navy-600"
        >
          Cancel
        </button>
        <button
          onClick={handleCreate}
          disabled={!canCreate}
          className="flex-1 rounded-md bg-cyan-accent/20 px-4 py-2 text-sm text-cyan-accent transition-colors hover:bg-cyan-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Create
        </button>
      </div>
    </div>
  );
}

/**
 * OnboardingScreen with animation state management.
 */
export function OnboardingScreen({ onOpenProject, onNewProject }: OnboardingScreenProps) {
  const [animationComplete, setAnimationComplete] = useState(false);
  const [naming, setNaming] = useState(false);

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-navy-base">
      <LogoAnimation size="lg" onComplete={() => setAnimationComplete(true)} />

      <div
        className={`mt-8 flex flex-col items-center gap-4 transition-opacity duration-500 ${
          animationComplete ? "opacity-100" : "opacity-0"
        }`}
      >
        <h1 className="font-display text-lg text-cyan-accent">
          Welcome to GSD Mission Control
        </h1>
        <p className="text-sm text-slate-400">
          Create a new project or open an existing one to get started
        </p>

        {naming ? (
          <NamingForm
            onCancel={() => setNaming(false)}
            onCreate={(name, location) => {
              setNaming(false);
              onNewProject(name, location);
            }}
          />
        ) : (
          <div className="mt-4 flex gap-3">
            <button
              onClick={onOpenProject}
              className="rounded-md bg-navy-700 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-navy-600"
            >
              Open Project
            </button>
            <button
              onClick={() => setNaming(true)}
              className="rounded-md bg-cyan-accent/20 px-4 py-2 text-sm text-cyan-accent transition-colors hover:bg-cyan-accent/30"
            >
              New Project
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Pure render function for testing (no hooks).
 * @deprecated Use OnboardingScreen instead.
 */
export function OnboardingScreenView({
  animationComplete,
  onOpenProject,
  onNewProject,
}: {
  animationComplete: boolean;
  onOpenProject: () => void;
  onNewProject: (name: string, location: string) => void;
}) {
  const [naming, setNaming] = useState(false);

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-navy-base">
      <LogoAnimation size="lg" />

      <div
        className={`mt-8 flex flex-col items-center gap-4 transition-opacity duration-500 ${
          animationComplete ? "opacity-100" : "opacity-0"
        }`}
      >
        <h1 className="font-display text-lg text-cyan-accent">
          Welcome to GSD Mission Control
        </h1>
        <p className="text-sm text-slate-400">
          Create a new project or open an existing one to get started
        </p>

        {naming ? (
          <NamingForm
            onCancel={() => setNaming(false)}
            onCreate={(name, location) => {
              setNaming(false);
              onNewProject(name, location);
            }}
          />
        ) : (
          <div className="mt-4 flex gap-3">
            <button
              onClick={onOpenProject}
              className="rounded-md bg-navy-700 px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-navy-600"
            >
              Open Project
            </button>
            <button
              onClick={() => setNaming(true)}
              className="rounded-md bg-cyan-accent/20 px-4 py-2 text-sm text-cyan-accent transition-colors hover:bg-cyan-accent/30"
            >
              New Project
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
