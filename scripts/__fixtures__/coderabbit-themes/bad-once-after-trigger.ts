// FIXTURE — known-bad once-after-trigger pattern (3 same-receiver cases)
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export async function bad1() {
  const proc = spawn("sleep", ["0.01"]);
  proc.kill("SIGINT");
  await new Promise((resolve) => proc.once("exit", resolve));
}

export async function bad2() {
  const em = new EventEmitter();
  em.emit("ready");
  em.once("ready", () => console.log("got it"));
}

export async function bad3() {
  const em = new EventEmitter();
  em.emit("data", 42);
  em.once("data", (d) => console.log(d));
}
