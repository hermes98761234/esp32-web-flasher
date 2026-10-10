import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Device, hasWebSerial } from './lib/device.ts'
import type { ChipInfo } from './lib/device.ts'
import { demoFiles } from './lib/demo.ts'
import { formatBytes, hex, parseOffset } from './lib/format.ts'
import { checkLayout, guessRole, inspectImage, suggestOffset } from './lib/image.ts'
import type { FileRole, ImageInfo } from './lib/image.ts'
import { parseManifest, pickBuild, resolvePartUrl } from './lib/manifest.ts'
import type { Manifest } from './lib/manifest.ts'
import { appendText } from './lib/monitor.ts'
import { tr } from './i18n.ts'
import type { T } from './i18n.ts'
import { loadSettings, saveSettings } from './settings.ts'
import type { Settings } from './settings.ts'

interface Entry {
  id: number
  name: string
  data: Uint8Array
  offsetText: string
  role: FileRole
  info: ImageInfo
  demo: boolean
}

type Busy = null | 'connecting' | 'flashing' | 'erasing'

const BAUDS = [115200, 230400, 460800, 921600, 1500000]
const MONITOR_BAUDS = [9600, 74880, 115200, 230400, 460800, 921600]
const ROLE_LABEL: Record<FileRole, string> = {
  bootloader: 'bootloader', partitions: 'partition table', boot_app0: 'boot_app0', app: 'application', other: 'unknown file',
}
const REPO = 'https://github.com/hermes98761234/esp32-web-flasher'

function flashBytes(size: string | null): number | undefined {
  const m = size && /^(\d+)(MB|KB)$/.exec(size)
  return m ? +m[1] * (m[2] === 'MB' ? 1048576 : 1024) : undefined
}

function download(name: string, text: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export default function App() {
  const [s, setS] = useState<Settings>(loadSettings)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => ({ ...p, [k]: v }))
  const t: T = useCallback((str, ...a) => tr(s.lang, str, ...a), [s.lang])
  useEffect(() => {
    saveSettings(s)
    document.documentElement.dataset.theme = s.theme === 'system' ? '' : s.theme
    document.documentElement.lang = s.lang
  }, [s])

  const [log, setLog] = useState<string[]>([])
  const addLog = useCallback((line: string) => setLog((l) => [...l.slice(-500), line]), [])
  const [device] = useState(() => new Device((line) => setLog((l) => [...l.slice(-500), line])))

  const [chip, setChip] = useState<ChipInfo | null>(null)
  const [portOpen, setPortOpen] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [status, setStatus] = useState<{ text: string; kind: 'ok' | 'err' | '' }>({ text: '', kind: '' })
  const [files, setFiles] = useState<Entry[]>([])
  const [progress, setProgress] = useState<{ file: number; pct: number } | null>(null)
  const [url, setUrl] = useState('')
  const [manifest, setManifest] = useState<{ m: Manifest; base: string; local: File[] } | null>(null)
  const [buildIdx, setBuildIdx] = useState(0)
  const [mon, setMon] = useState<string[]>([''])
  const [monitoring, setMonitoring] = useState(false)
  const [monInput, setMonInput] = useState('')
  const [eol, setEol] = useState('\n')
  const nextId = useRef(1)
  const serial = hasWebSerial()

  const fail = useCallback((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e)
    addLog(`Error: ${msg}`)
    setStatus({ text: tr(s.lang, 'Error: {0}', msg), kind: 'err' })
  }, [addLog, s.lang])

  const chipName = chip?.chip ?? null

  const makeEntry = useCallback((name: string, data: Uint8Array, offset: number | null, demo = false): Entry => {
    const role = guessRole(name, data)
    const off = offset ?? suggestOffset(role, chipName ?? 'ESP32')
    return { id: nextId.current++, name, data, offsetText: hex(off), role, info: inspectImage(data), demo }
  }, [chipName])

  const addFiles = useCallback(async (list: FileList | File[]) => {
    const made: Entry[] = []
    for (const f of Array.from(list)) made.push(makeEntry(f.name, new Uint8Array(await f.arrayBuffer()), null))
    setFiles((p) => [...p, ...made])
  }, [makeEntry])

  const fetchBin = async (u: string): Promise<Uint8Array> => {
    const r = await fetch(u)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return new Uint8Array(await r.arrayBuffer())
  }

  const loadUrl = async () => {
    try {
      const u = new URL(url, location.href).toString()
      const data = await fetchBin(u)
      const name = decodeURIComponent(u.split('?')[0].split('/').pop() || 'firmware.bin')
      setFiles((p) => [...p, makeEntry(name, data, null)])
    } catch (e) {
      addLog(t('Could not load {0}: {1}', url, e instanceof Error ? e.message : String(e)))
      setStatus({ text: t('Could not load {0}: {1}', url, e instanceof Error ? e.message : String(e)) + ' ' + t('Remote servers must allow cross-origin requests (CORS).'), kind: 'err' })
    }
  }

  const loadManifestUrl = async () => {
    try {
      const base = new URL(s.manifestUrl, location.href).toString()
      const r = await fetch(base)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const m = parseManifest(await r.json())
      setManifest({ m, base, local: [] })
      setBuildIdx(0)
      setStatus({ text: '', kind: '' })
    } catch (e) {
      fail(e)
    }
  }

  const openManifestFile = async (list: FileList | null) => {
    if (!list?.length) return
    try {
      const all = Array.from(list)
      const mf = all.find((f) => f.name.endsWith('.json')) ?? all[0]
      const m = parseManifest(JSON.parse(await mf.text()))
      setManifest({ m, base: location.href, local: all.filter((f) => f !== mf) })
      setBuildIdx(0)
    } catch (e) {
      fail(e)
    }
  }

  const activeBuild = useMemo(() => {
    if (!manifest) return null
    return (chipName ? pickBuild(manifest.m, chipName) : null) ?? manifest.m.builds[buildIdx] ?? null
  }, [manifest, chipName, buildIdx])

  const loadFromManifest = async () => {
    if (!manifest) return
    if (chipName && !pickBuild(manifest.m, chipName)) {
      setStatus({ text: t('No build in the manifest for {0}', chipName), kind: 'err' })
      return
    }
    if (!activeBuild) return
    const made: Entry[] = []
    for (const part of activeBuild.parts) {
      try {
        const base = part.path.split('/').pop() ?? part.path
        const local = manifest.local.find((f) => f.name === base)
        const data = local ? new Uint8Array(await local.arrayBuffer()) : await fetchBin(resolvePartUrl(part.path, manifest.base))
        made.push(makeEntry(base, data, part.offset))
      } catch (e) {
        const msg = t('Could not load {0}: {1}', part.path, e instanceof Error ? e.message : String(e))
        addLog(msg)
        setStatus({ text: msg + ' ' + t('Remote servers must allow cross-origin requests (CORS).'), kind: 'err' })
        return
      }
    }
    setFiles(made)
    setStatus({ text: '', kind: '' })
  }

  const loadDemo = () => setFiles(demoFiles().map((d) => makeEntry(d.name, d.data, d.offset, true)))

  const plan = files.map((f) => ({ name: f.name, offset: parseOffset(f.offsetText), size: f.data.length }))
  const issues = checkLayout(plan, flashBytes(chip?.flashSize ?? null))
  const chipIssues = files.flatMap((f, i) => {
    const c = f.info.chip
    return c && chipName && !chipName.startsWith('ESP8266') && !chipName.toUpperCase().startsWith(c) && !(c === 'ESP32' && chipName.toUpperCase().startsWith('ESP32-D'))
      ? [{ level: 'warn' as const, message: '{0} is built for {1}, but the connected chip is {2}', args: [f.name, c, chipName], index: i }]
      : []
  })
  const allIssues = [...issues, ...chipIssues]
  const hasErrors = issues.some((i) => i.level === 'error')

  // Device actions ---------------------------------------------------------
  const connect = async () => {
    setBusy('connecting')
    setStatus({ text: '', kind: '' })
    try {
      if (!device.hasPort) await device.pick()
      setPortOpen(true)
      setMonitoring(false)
      const info = await device.connect(s.baud)
      setChip(info)
      setStatus({ text: t('Connected: {0}', info.description), kind: 'ok' })
    } catch (e) {
      setChip(null)
      setPortOpen(device.hasPort)
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async () => {
    await device.disconnect()
    setChip(null)
    setPortOpen(false)
    setMonitoring(false)
    setStatus({ text: '', kind: '' })
  }

  const ensureBoot = async () => {
    if (device.inBootloader) return true
    if (!device.hasPort) { setStatus({ text: t('Connect first.'), kind: 'err' }); return false }
    setMonitoring(false)
    setChip(await device.connect(s.baud))
    return true
  }

  const run = async (kind: Exclude<Busy, null | 'connecting'>, fn: () => Promise<void>) => {
    setBusy(kind)
    setStatus({ text: '', kind: '' })
    try {
      if (await ensureBoot()) await fn()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const flash = () => {
    if (!files.length) return setStatus({ text: t('Add at least one file.'), kind: 'err' })
    if (hasErrors) return setStatus({ text: t('Fix the file offsets first.'), kind: 'err' })
    void run('flashing', async () => {
      const usable = files.filter((f) => f.data.length)
      await device.flash({
        files: usable.map((f) => ({ data: f.data, address: parseOffset(f.offsetText)! })),
        flashMode: s.flashMode,
        flashFreq: s.flashFreq,
        flashSize: s.flashSize,
        eraseAll: s.eraseAll,
        compress: s.compress,
        onProgress: (file, written, total) => setProgress({ file, pct: total ? Math.round((written / total) * 100) : 0 }),
      })
      await device.reset()
      addLog('Flash complete.')
      setStatus({ text: t('Flash complete. Device reset.'), kind: 'ok' })
    })
  }

  const erase = () => {
    if (!confirm(t('Erase the whole flash? All data on the chip is lost.'))) return
    void run('erasing', async () => {
      await device.erase()
      addLog('Flash erased.')
    })
  }

  const readMac = () => void run('erasing', async () => {
    const mac = await device.readMac()
    setChip(device.info)
    setStatus({ text: t('MAC: {0}', mac), kind: 'ok' })
  })

  const hardReset = () => void run('erasing', async () => { await device.reset() })

  const startMonitor = async () => {
    try {
      setMon([''])
      await device.startMonitor(
        s.monitorBaud,
        (text) => setMon((l) => appendText(l, text)),
        () => setMonitoring(false),
      )
      setChip(null)
      setMonitoring(true)
    } catch (e) {
      fail(e)
    }
  }

  const stopMonitor = async () => {
    await device.stopMonitor()
    setMonitoring(false)
  }

  const sendMonitor = () => {
    void device.sendMonitor(monInput + eol)
    setMonInput('')
  }

  // Keep the log scrolled to the end.
  const logRef = useRef<HTMLPreElement>(null)
  const monRef = useRef<HTMLPreElement>(null)
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [log])
  useEffect(() => { monRef.current?.scrollTo(0, monRef.current.scrollHeight) }, [mon])

  const connected = chip !== null
  const working = busy !== null
  const demoLoaded = files.some((f) => f.demo)
  const overall = progress && files.length ? Math.round(((progress.file + progress.pct / 100) / files.filter((f) => f.data.length).length) * 100) : 0
  const [drag, setDrag] = useState(false)

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">{t('ESP32 Web Flasher')}</span>
        <span className="muted">{t('Flash ESP32 and ESP8266 firmware from your browser.')}</span>
        <span className="spacer" />
        <label className="inline">{t('Theme')}
          <select value={s.theme} onChange={(e) => set('theme', e.target.value as Settings['theme'])}>
            <option value="system">{t('System')}</option>
            <option value="light">{t('Light')}</option>
            <option value="dark">{t('Dark')}</option>
          </select>
        </label>
        <label className="inline">{t('Language')}
          <select value={s.lang} onChange={(e) => set('lang', e.target.value as Settings['lang'])}>
            <option value="en">English</option>
            <option value="uk">Українська</option>
          </select>
        </label>
      </header>

      <div className="body">
        <aside className="side"><div className="panel">
          {!serial && <p className="banner">{t('Web Serial is not available in this browser. Use Chrome, Edge or Opera on a desktop. You can still prepare files here.')}</p>}
          <section className="section">
            <h3>{t('Device')}</h3>
            <p className={'conn ' + (connected ? 'ok-text' : 'muted')}>
              {busy === 'connecting' ? t('Connecting') : connected ? t('Connected: {0}', chip.chip) : portOpen ? t('Port open, not in bootloader') : t('Not connected')}
            </p>
            <div className="field">
              <label htmlFor="baud">{t('Flash baud rate')}</label>
              <select id="baud" value={s.baud} onChange={(e) => set('baud', +e.target.value)} disabled={working}>
                {BAUDS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div className="row">
              <button className="primary" onClick={connect} disabled={!serial || working}>{busy === 'connecting' ? t('Connecting') : t('Connect')}</button>
              <button onClick={disconnect} disabled={!portOpen || working}>{t('Disconnect')}</button>
            </div>
            <p className="hint">{t('Hold BOOT while connecting if the chip does not respond.')}</p>
            {chip && (
              <table className="data info">
                <tbody>
                  <tr><td>{t('Chip')}</td><td>{chip.description}</td></tr>
                  <tr><td>MAC</td><td className="mono">{chip.mac || '-'}</td></tr>
                  <tr><td>{t('Features')}</td><td>{chip.features.join(', ') || '-'}</td></tr>
                  <tr><td>{t('Crystal')}</td><td>{chip.crystalMHz ? `${chip.crystalMHz} MHz` : '-'}</td></tr>
                  <tr><td>{t('Flash size')}</td><td>{chip.flashSize ?? t('unknown')}</td></tr>
                </tbody>
              </table>
            )}
            <div className="row">
              <button onClick={readMac} disabled={!portOpen || working}>{t('Read MAC')}</button>
              <button onClick={hardReset} disabled={!portOpen || working}>{t('Hard reset')}</button>
              <button className="danger" onClick={erase} disabled={!portOpen || working}>{t('Erase flash')}</button>
            </div>
          </section>

          <section className="section">
            <h3>{t('Flash options')}</h3>
            <div className="grid2">
              <div className="field">
                <label htmlFor="fm">{t('Flash mode')}</label>
                <select id="fm" value={s.flashMode} onChange={(e) => set('flashMode', e.target.value as Settings['flashMode'])}>
                  <option value="keep">{t('keep (from image)')}</option>
                  {['qio', 'dio', 'qout', 'dout'].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ff">{t('Flash frequency')}</label>
                <select id="ff" value={s.flashFreq} onChange={(e) => set('flashFreq', e.target.value as Settings['flashFreq'])}>
                  <option value="keep">{t('keep (from image)')}</option>
                  {['80m', '40m', '26m', '20m'].map((m) => <option key={m} value={m}>{m.toUpperCase()}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="fs">{t('Flash size')}</label>
              <select id="fs" value={s.flashSize} onChange={(e) => set('flashSize', e.target.value as Settings['flashSize'])}>
                <option value="keep">{t('keep (from image)')}</option>
                <option value="detect">{t('detect')}</option>
                {['1MB', '2MB', '4MB', '8MB', '16MB', '32MB'].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <label className="check"><input type="checkbox" checked={s.compress} onChange={(e) => set('compress', e.target.checked)} /> {t('Compress transfer')}</label>
            <label className="check"><input type="checkbox" checked={s.eraseAll} onChange={(e) => set('eraseAll', e.target.checked)} /> {t('Erase all flash first')}</label>
          </section>
        </div></aside>

        <main className="main">
          <section className="box">
            <h3>{t('Firmware')}</h3>
            <div
              className={'drop' + (drag ? ' over' : '')}
              onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); void addFiles(e.dataTransfer.files) }}
            >
              <span>{t('Drop .bin files here or choose them.')}</span>
              <label className="btn">{t('Add files')}
                <input type="file" multiple accept=".bin,.img,application/octet-stream" hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = '' }} />
              </label>
              <button onClick={loadDemo}>{t('Load demo files')}</button>
            </div>
            <div className="row">
              <input type="url" className="grow" placeholder={t('Firmware URL')} aria-label={t('Firmware URL')} value={url} onChange={(e) => setUrl(e.target.value)} />
              <button onClick={loadUrl} disabled={!url.trim()}>{t('Load from URL')}</button>
            </div>
            <details open={!!manifest}>
              <summary>{t('Manifest (ESP Web Tools)')}</summary>
              <div className="row">
                <input type="url" className="grow" placeholder={t('Manifest URL')} aria-label={t('Manifest URL')} value={s.manifestUrl} onChange={(e) => set('manifestUrl', e.target.value)} />
                <button onClick={loadManifestUrl} disabled={!s.manifestUrl.trim()}>{t('Load')}</button>
                <label className="btn">{t('Open manifest file')}
                  <input type="file" multiple hidden onChange={(e) => { void openManifestFile(e.target.files); e.target.value = '' }} />
                </label>
              </div>
              {manifest && (
                <div className="row">
                  <b>{t('Manifest: {0}', manifest.m.name + (manifest.m.version ? ' ' + manifest.m.version : ''))}</b>
                  {!chipName && manifest.m.builds.length > 1 && (
                    <select aria-label={t('Build for {0}', '')} value={buildIdx} onChange={(e) => setBuildIdx(+e.target.value)}>
                      {manifest.m.builds.map((b, i) => <option key={i} value={i}>{t('Build for {0}', b.chipFamily)}</option>)}
                    </select>
                  )}
                  <button onClick={loadFromManifest}>{t('Load files from manifest')}</button>
                </div>
              )}
            </details>

            {files.length === 0 ? <p className="hint">{t('No files yet. Add firmware, load a manifest, or try the demo files.')}</p> : (
              <div className="tablewrap">
                <table className="data files">
                  <thead><tr><th>{t('File')}</th><th>{t('Size')}</th><th>{t('Offset')}</th><th>{t('Details')}</th><th /></tr></thead>
                  <tbody>
                    {files.map((f, i) => {
                      const bad = plan[i].offset === null
                      return (
                        <tr key={f.id}>
                          <td className="mono">{f.name}</td>
                          <td>{formatBytes(f.data.length)}</td>
                          <td>
                            <input className={'mono offset' + (bad ? ' bad' : '')} aria-label={t('Offset')} aria-invalid={bad} value={f.offsetText}
                              onChange={(e) => setFiles((p) => p.map((x) => (x.id === f.id ? { ...x, offsetText: e.target.value } : x)))} />
                          </td>
                          <td>{t(ROLE_LABEL[f.role])}{f.info.chip ? ` · ${f.info.chip}` : ''}{f.info.segments ? ` · ${t('segments {0}', f.info.segments)}` : ''}</td>
                          <td><button className="small danger" onClick={() => setFiles((p) => p.filter((x) => x.id !== f.id))}>{t('Remove')}</button></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {allIssues.length > 0 && (
              <ul className="issues">
                {allIssues.map((i, k) => <li key={k} className={i.level === 'error' ? 'err-text' : 'warn-text'}>{t(i.message, ...i.args)}</li>)}
              </ul>
            )}
            {demoLoaded && <p className="hint">{t('Demo files are placeholders and cannot be flashed.')}</p>}
            <div className="row">
              <button className="primary" onClick={flash} disabled={!serial || working || files.length === 0 || demoLoaded}>
                {busy === 'flashing' ? t('Flashing…') : t('Flash {0} file(s)', files.length)}
              </button>
              <button onClick={() => setFiles([])} disabled={!files.length || working}>{t('Clear all')}</button>
              {busy === 'erasing' && <span className="muted">{t('Erasing…')}</span>}
            </div>
            {progress && (
              <div className="progress" role="progressbar" aria-valuenow={overall} aria-valuemin={0} aria-valuemax={100}>
                <div className="bar" style={{ width: `${overall}%` }} />
                <span>{files.filter((f) => f.data.length)[progress.file]?.name} · {progress.pct}% · {overall}%</span>
              </div>
            )}
            {status.text && <p className={'status ' + status.kind} role="status">{status.text}</p>}
          </section>

          <section className="box">
            <div className="row"><h3 className="grow">{t('Log')}</h3>
              <button className="small" onClick={() => download('flasher-log.txt', log.join('\n'))} disabled={!log.length}>{t('Save log')}</button>
              <button className="small" onClick={() => setLog([])} disabled={!log.length}>{t('Clear')}</button>
            </div>
            <pre className="console" ref={logRef} aria-live="off">{log.join('\n')}</pre>
          </section>

          <section className="box">
            <h3>{t('Serial monitor')}</h3>
            <p className="hint">{t('The monitor resets the chip and shows its serial output.')}</p>
            <div className="row">
              <label className="inline">{t('Monitor baud rate')}
                <select value={s.monitorBaud} onChange={(e) => set('monitorBaud', +e.target.value)} disabled={monitoring}>
                  {MONITOR_BAUDS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
              {monitoring
                ? <button onClick={stopMonitor}>{t('Stop monitor')}</button>
                : <button onClick={startMonitor} disabled={!portOpen || working}>{t('Start monitor')}</button>}
              <button className="small" onClick={() => download('monitor-log.txt', mon.join('\n'))}>{t('Save log')}</button>
              <button className="small" onClick={() => setMon([''])}>{t('Clear')}</button>
              {monitoring && <span className="ok-text">{t('Monitor is running')}</span>}
            </div>
            <pre className="console" ref={monRef}>{mon.join('\n')}</pre>
            <div className="row">
              <input className="grow" aria-label={t('Send to device')} placeholder={t('Send to device')} value={monInput} disabled={!monitoring}
                onChange={(e) => setMonInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendMonitor() }} />
              <select aria-label={t('Line ending')} value={eol} onChange={(e) => setEol(e.target.value)}>
                <option value="">{t('None')}</option>
                <option value={'\n'}>{t('Newline')}</option>
                <option value={'\r'}>{t('Carriage return')}</option>
                <option value={'\r\n'}>{t('Both')}</option>
              </select>
              <button onClick={sendMonitor} disabled={!monitoring}>{t('Send')}</button>
            </div>
          </section>
        </main>
      </div>

      <footer className="foot muted">
        {t('Everything runs locally. Your firmware never leaves this computer.')} ·{' '}
        <a href={REPO} target="_blank" rel="noreferrer">{t('Source on GitHub')}</a>
      </footer>
    </div>
  )
}
