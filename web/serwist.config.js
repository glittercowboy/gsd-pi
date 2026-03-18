// @ts-check
import { spawnSync } from "node:child_process";
import { serwist } from "@serwist/next/config";

const revision = (() => {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" });
    if (r.stdout?.trim()) return r.stdout.trim();
  } catch {}
  return crypto.randomUUID();
})();

export default serwist({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  additionalPrecacheEntries: [{ url: "/", revision }],
});
