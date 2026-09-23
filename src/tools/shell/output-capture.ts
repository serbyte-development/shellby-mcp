import { utf8Chunk } from "../../utils.js"

/** Retain whole UTF-8 characters within one command's byte budget and count discarded bytes. */
export function createOutputCapture(maxBytes: number) {
  let capturedBytes = 0
  let droppedBytes = 0

  return {
    append(chunk: string): string {
      const bounded = utf8Chunk(chunk, 0, Math.max(0, maxBytes - capturedBytes))
      capturedBytes += Buffer.byteLength(bounded.value, "utf8")
      droppedBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        droppedBytes + Buffer.byteLength(chunk.slice(bounded.nextOffset), "utf8")
      )
      return bounded.value
    },
    get droppedBytes() {
      return droppedBytes
    },
  }
}
