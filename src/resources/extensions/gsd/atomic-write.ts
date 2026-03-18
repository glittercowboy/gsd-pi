import { writeFileSync, renameSync, unlinkSync, mkdirSync, promises as fs } from "node:fs"
import { dirname } from "node:path"
import { randomBytes } from "node:crypto"

/**
 * Atomically writes content to a file by writing to a temp file first,
 * then renaming. Prevents partial/corrupt files on crash.
 */
export function atomicWriteSync(filePath: string, content: string, encoding: BufferEncoding = "utf-8"): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = filePath + `.tmp.${randomBytes(4).toString("hex")}`
  writeFileSync(tmpPath, content, encoding)
  try {
    renameSync(tmpPath, filePath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* orphan cleanup best-effort */ }
    throw err
  }
}

/**
 * Async variant of atomicWriteSync. Atomically writes content to a file
 * by writing to a temp file first, then renaming.
 */
export async function atomicWriteAsync(filePath: string, content: string, encoding: BufferEncoding = "utf-8"): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const tmpPath = filePath + `.tmp.${randomBytes(4).toString("hex")}`
  await fs.writeFile(tmpPath, content, encoding)
  try {
    await fs.rename(tmpPath, filePath)
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => { /* orphan cleanup best-effort */ })
    throw err
  }
}
