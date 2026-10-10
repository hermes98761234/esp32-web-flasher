import type { Lang } from './i18n.ts'

export type Theme = 'system' | 'light' | 'dark'

export interface Settings {
  lang: Lang
  theme: Theme
  baud: number
  monitorBaud: number
  flashMode: 'keep' | 'qio' | 'dio' | 'qout' | 'dout'
  flashFreq: 'keep' | '80m' | '40m' | '26m' | '20m'
  flashSize: 'keep' | 'detect' | '1MB' | '2MB' | '4MB' | '8MB' | '16MB' | '32MB'
  compress: boolean
  eraseAll: boolean
  manifestUrl: string
}

export const DEFAULTS: Settings = {
  lang: typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('uk') ? 'uk' : 'en',
  theme: 'system',
  baud: 460800,
  monitorBaud: 115200,
  flashMode: 'keep',
  flashFreq: 'keep',
  flashSize: 'keep',
  compress: true,
  eraseAll: false,
  manifestUrl: '',
}

const KEY = 'esp32-web-flasher:settings'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch { /* ignore corrupt storage */ }
  return DEFAULTS
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* storage unavailable */ }
}
