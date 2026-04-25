// FIXTURE — known-good once-after-trigger (listener before trigger)
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export async function good1() {
  const proc = spawn("sleep", ["0.01"]);
  const done = new Promise((resolve) => proc.once("exit", resolve));
  proc.kill("SIGINT");
  await done;
}

export async function good2() {
  const em = new EventEmitter();
  em.once("ready", () => console.log("got it"));
  em.emit("ready");
}

// Different receivers: otherProc.kill followed by proc.once (not otherProc.once)
// is fine because the listener is on a distinct emitter.
export async function good3() {
  const proc = spawn("sleep", ["0.01"]);
  const otherProc = spawn("sleep", ["0.01"]);
  otherProc.kill("SIGINT");
  proc.once("exit", () => console.log("proc exited"));
}
