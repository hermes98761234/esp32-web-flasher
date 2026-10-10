/** Human-readable byte size, e.g. 1536 -> "1.5 KB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** Offset as 0x-prefixed lowercase hex. */
export function hex(n: number): string {
  return '0x' + n.toString(16)
}

/** Parses "0x1000", "4096", "64k", "1M" (case-insensitive) into a non-negative integer, or null. */
export function parseOffset(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/_/g, '')
  const m = /^(0x[0-9a-f]+|\d+)([km])?$/.exec(t)
  if (!m) return null
  const base = m[1].startsWith('0x') ? parseInt(m[1], 16) : parseInt(m[1], 10)
  const mult = m[2] === 'k' ? 1024 : m[2] === 'm' ? 1024 * 1024 : 1
  const v = base * mult
  return Number.isSafeInteger(v) && v <= 0xffffffff ? v : null
}

/** Formats a MAC as given by esptool-js, upper-cased. */
export function normalizeMac(mac: string): string {
  return mac.trim().toUpperCase()
}
