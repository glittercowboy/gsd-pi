// FIXTURE — known-good sqlite guard patterns
import Database from "better-sqlite3";

const db = new Database(":memory:");
const stmt = db.prepare("SELECT v FROM t WHERE k = ?");

export function good1(k: string) {
  const row = stmt.get(k);
  if (row != null) {
    return (row as { v: number }).v;
  }
  return 0;
}

export function good2(k: string) {
  const row = stmt.get(k);
  if (row === undefined) return null;
  return row;
}

export function good3(k: string) {
  const r = stmt.pluck().get(k);
  return r ?? "default";
}

export function good4(k: string) {
  const row = stmt.get(k);
  if (row) {
    return (row as { v: number }).v;
  }
}

// Unrelated null guard on a non-Statement-.get value must not trigger.
export function unrelated(obj: { v: number } | null) {
  if (obj !== null) return obj.v;
  return 0;
}
