export function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, received ${value}.`)
  }
  return value
}

export function nonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected a non-negative integer, received ${value}.`)
  }
  return value
}
