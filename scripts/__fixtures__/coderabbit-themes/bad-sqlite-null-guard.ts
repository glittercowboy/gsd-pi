// FIXTURE — known-bad sqlite-null-guard pattern
import Database from "better-sqlite3";

const db = new Database(":memory:");
const stmt = db.prepare("SELECT v FROM t WHERE k = ?");

export function bad1(k: string) {
  const row = stmt.get(k);
  if (row !== null) {
    return (row as { v: number }).v;
  }
  return 0;
}

export function bad2(k: string) {
  const row = stmt.get(k);
  if (row === null) return null;
  return row;
}

export function bad3(k: string) {
  const r = stmt.pluck().get(k);
  return r !== null ? r : "default";
}
