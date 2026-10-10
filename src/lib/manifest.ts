/** ESP Web Tools-style manifest: https://esphome.github.io/esp-web-tools/ */

export interface ManifestPart { path: string; offset: number }
export interface ManifestBuild { chipFamily: string; parts: ManifestPart[] }
export interface Manifest { name: string; version?: string; builds: ManifestBuild[] }

/** Throws an Error (English message) when the JSON is not a usable manifest. */
export function parseManifest(json: unknown): Manifest {
  if (typeof json !== 'object' || json === null) throw new Error('Manifest must be a JSON object')
  const o = json as Record<string, unknown>
  if (!Array.isArray(o.builds) || o.builds.length === 0) throw new Error('Manifest has no builds')
  const builds: ManifestBuild[] = o.builds.map((b, i) => {
    const bo = b as Record<string, unknown>
    if (typeof bo?.chipFamily !== 'string') throw new Error(`Build ${i + 1} has no chipFamily`)
    if (!Array.isArray(bo.parts) || bo.parts.length === 0) throw new Error(`Build ${i + 1} has no parts`)
    const parts = bo.parts.map((p, j) => {
      const po = p as Record<string, unknown>
      if (typeof po?.path !== 'string') throw new Error(`Build ${i + 1}, part ${j + 1} has no path`)
      if (typeof po.offset !== 'number' || !Number.isInteger(po.offset) || po.offset < 0) {
        throw new Error(`Build ${i + 1}, part ${j + 1} has an invalid offset`)
      }
      return { path: po.path, offset: po.offset }
    })
    return { chipFamily: bo.chipFamily, parts }
  })
  return {
    name: typeof o.name === 'string' ? o.name : 'Firmware',
    version: typeof o.version === 'string' ? o.version : undefined,
    builds,
  }
}

/** Normalises chip names so "ESP32-S3", "esp32s3" and "ESP32-S3 (QFN56)" compare equal. */
export function chipKey(name: string): string {
  return name.toUpperCase().replace(/\s*\(.*$/, '').replace(/[^A-Z0-9]/g, '')
}

/** Picks the build for a connected chip (exact family match, else prefix such as ESP32-D0WD -> ESP32). */
export function pickBuild(m: Manifest, chip: string | null): ManifestBuild | null {
  if (!chip) return m.builds.length === 1 ? m.builds[0] : null
  const key = chipKey(chip)
  return (
    m.builds.find((b) => chipKey(b.chipFamily) === key) ??
    m.builds.find((b) => chipKey(b.chipFamily) === 'ESP32' && /^ESP32(D|PICO|U4|S0)/.test(key)) ??
    null
  )
}

/** Resolves a part path against the manifest's own URL (or the page URL for local manifests). */
export function resolvePartUrl(path: string, manifestUrl: string): string {
  return new URL(path, manifestUrl).toString()
}
