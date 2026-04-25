import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";

import { handleNotificationsCommand } from "../commands/handlers/notifications-handler.ts";
import {
  _resetNotificationStore,
  appendNotification,
  initNotificationStore,
} from "../notification-store.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-notifications-handler-test-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

test("notifications command falls back to text output when overlay returns undefined", async (t) => {
  const base = makeTempDir("overlay-fallback");
  initNotificationStore(base);
  appendNotification("Build complete", "success");

  t.after(() => {
    _resetNotificationStore();
    cleanup(base);
  });

  const notices: Array<{ message: string; level?: string }> = [];
  await handleNotificationsCommand(
    "",
    {
      hasUI: true,
      ui: {
        custom: async () => undefined,
        notify: (message: string, level?: string) => {
          notices.push({ message, level });
        },
      },
    } as any,
    {} as any,
  );

  assert.equal(notices.length, 1, "text fallback should be emitted when overlay cannot render");
  assert.match(notices[0].message, /Recent notifications:/);
});

test("notifications tail caps inline output and hints to open overlay", async (t) => {
  const base = makeTempDir("tail-cap");
  initNotificationStore(base);
  for (let i = 0; i < 55; i++) {
    appendNotification(`notification-${i + 1}`, "info");
  }

  t.after(() => {
    _resetNotificationStore();
    cleanup(base);
  });

  const notices: Array<{ message: string; level?: string }> = [];
  await handleNotificationsCommand(
    "tail 200",
    {
      hasUI: true,
      ui: {
        notify: (message: string, level?: string) => {
          notices.push({ message, level });
        },
      },
    } as any,
    {} as any,
  );

  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /Last 40 notification\(s\):/);
  assert.match(notices[0].message, /\.\.\. and \d+ more \(open \/gsd notifications to browse all\)/);
});
