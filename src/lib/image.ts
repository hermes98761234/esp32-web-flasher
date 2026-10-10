/** Inspection of ESP firmware images and a layout checker for the flash plan. */

export interface ImageInfo {
  kind: 'app' | 'partition-table' | 'unknown'
  /** Chip named in the extended image header (ESP32 family), when present. */
  chip?: string
  flashMode?: 'qio' | 'qout' | 'dio' | 'dout'
  flashSize?: string
  segments?: number
}

const CHIP_IDS: Record<number, string> = {
  0: 'ESP32', 2: 'ESP32-S2', 5: 'ESP32-C3', 9: 'ESP32-S3', 12: 'ESP32-C2', 13: 'ESP32-C6',
  16: 'ESP32-H2', 18: 'ESP32-P4', 20: 'ESP32-C61', 23: 'ESP32-C5',
}
const FLASH_MODES = ['qio', 'qout', 'dio', 'dout'] as const
const FLASH_SIZES: Record<number, string> = { 0: '1MB', 1: '2MB', 2: '4MB', 3: '8MB', 4: '16MB', 5: '32MB', 6: '64MB', 7: '128MB' }

/** Reads the 24-byte image header (magic 0xE9) or the partition table magic (0xAA 0x50). */
export function inspectImage(data: Uint8Array): ImageInfo {
  if (data.length >= 2 && data[0] === 0xaa && data[1] === 0x50) return { kind: 'partition-table' }
  if (data.length >= 8 && data[0] === 0xe9) {
    const info: ImageInfo = { kind: 'app', segments: data[1], flashMode: FLASH_MODES[data[2]] }
    info.flashSize = FLASH_SIZES[data[3] >> 4]
    if (data.length >= 24) {
      const id = data[12] | (data[13] << 8)
      // ESP8266 images leave this field as zero too, so ESP32 is only a hint.
      info.chip = CHIP_IDS[id]
    }
    return info
  }
  return { kind: 'unknown' }
}

export type FileRole = 'bootloader' | 'partitions' | 'boot_app0' | 'app' | 'other'

/** Guesses what a file is from its name and contents. */
export function guessRole(name: string, data: Uint8Array): FileRole {
  const n = name.toLowerCase()
  if (n.includes('boot_app0')) return 'boot_app0'
  if (n.includes('bootloader')) return 'bootloader'
  if (n.includes('partition')) return 'partitions'
  if (inspectImage(data).kind === 'partition-table') return 'partitions'
  if (n.endsWith('.bin') || inspectImage(data).kind === 'app') return 'app'
  return 'other'
}

/** Offset of the second-stage bootloader per chip (esptool docs). */
export function bootloaderOffset(chip: string): number {
  const c = chip.toUpperCase()
  if (c.startsWith('ESP8266')) return 0x0
  if (c === 'ESP32' || c.startsWith('ESP32-S2') || c === 'ESP32-D0WD' || /^ESP32-(D|PICO|U4|S0)/.test(c)) return 0x1000
  if (c.startsWith('ESP32-P4') || c.startsWith('ESP32-C5')) return 0x2000
  if (c.startsWith('ESP32-')) return 0x0
  return 0x1000
}

/** Conventional Arduino/ESP-IDF offset for a role on a given chip. */
export function suggestOffset(role: FileRole, chip: string): number {
  switch (role) {
    case 'bootloader': return bootloaderOffset(chip)
    case 'partitions': return 0x8000
    case 'boot_app0': return 0xe000
    case 'app': return chip.toUpperCase().startsWith('ESP8266') ? 0x0 : 0x10000
    default: return 0x10000
  }
}

export interface PlanEntry { name: string; offset: number | null; size: number }
export interface LayoutIssue { level: 'error' | 'warn'; message: string; args: (string | number)[]; index: number }

/**
 * Checks files for invalid offsets, overlaps, 4 KB alignment and overflow of the flash size.
 * Messages are English source strings (translated by the UI) with positional args.
 */
export function checkLayout(entries: PlanEntry[], flashBytes?: number): LayoutIssue[] {
  const issues: LayoutIssue[] = []
  const valid: { i: number; start: number; end: number }[] = []
  entries.forEach((e, i) => {
    if (e.offset === null) {
      issues.push({ level: 'error', message: 'Invalid offset for {0}', args: [e.name], index: i })
      return
    }
    if (e.size === 0) issues.push({ level: 'warn', message: '{0} is empty and will be skipped', args: [e.name], index: i })
    if (e.offset % 0x1000 !== 0) issues.push({ level: 'warn', message: '{0}: offset is not aligned to 4 KB', args: [e.name], index: i })
    if (flashBytes && e.offset + e.size > flashBytes) {
      issues.push({ level: 'error', message: '{0} does not fit in the flash', args: [e.name], index: i })
    }
    if (e.size > 0) valid.push({ i, start: e.offset, end: e.offset + e.size })
  })
  const sorted = [...valid].sort((a, b) => a.start - b.start)
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].start < sorted[k - 1].end) {
      issues.push({
        level: 'error',
        message: '{0} overlaps {1}',
        args: [entries[sorted[k].i].name, entries[sorted[k - 1].i].name],
        index: sorted[k].i,
      })
    }
  }
  return issues
}
