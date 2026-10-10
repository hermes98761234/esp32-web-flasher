/** Thin wrapper over esptool-js and the Web Serial API: one serial port, flasher session or monitor. */
import { ESPLoader, Transport } from 'esptool-js'
import type { FlashFreqValues, FlashModeValues, FlashSizeValues } from 'esptool-js'
import { md5Hex } from './md5.ts'

export interface ChipInfo {
  chip: string
  description: string
  features: string[]
  crystalMHz: number
  mac: string
  flashSize: string | null
}

export interface FlashJob {
  files: { data: Uint8Array; address: number }[]
  flashMode: FlashModeValues
  flashFreq: FlashFreqValues
  flashSize: FlashSizeValues
  eraseAll: boolean
  compress: boolean
  onProgress: (fileIndex: number, written: number, total: number) => void
}

export const hasWebSerial = (): boolean => typeof navigator !== 'undefined' && 'serial' in navigator

export class Device {
  private port: SerialPort | null = null
  private transport: Transport | null = null
  private loader: ESPLoader | null = null
  private monitorReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private monitorDone: Promise<void> | null = null
  info: ChipInfo | null = null

  private log: (line: string) => void

  constructor(log: (line: string) => void) {
    this.log = log
  }

  get hasPort(): boolean { return this.port !== null }
  get inBootloader(): boolean { return this.loader !== null }
  get monitoring(): boolean { return this.monitorReader !== null }

  /** Opens the browser's port picker. Must be called from a user gesture. */
  async pick(): Promise<void> {
    this.port = await navigator.serial.requestPort()
  }

  /** Resets into the ROM bootloader, syncs, optionally switches to a faster baud rate and reads chip info. */
  async connect(baud: number): Promise<ChipInfo> {
    if (!this.port) throw new Error('No port selected')
    await this.stopMonitor()
    await this.closeLoader()
    const transport = new Transport(this.port, false)
    const loader = new ESPLoader({
      transport,
      baudrate: baud,
      romBaudrate: 115200,
      terminal: {
        clean: () => {},
        write: (s) => this.log(s),
        writeLine: (s) => this.log(s),
      },
    })
    this.transport = transport
    this.loader = loader
    try {
      await loader.main('default_reset')
      const chip = loader.chip
      const secure = loader.secureDownloadMode
      const info: ChipInfo = {
        chip: chip.CHIP_NAME,
        description: secure ? chip.CHIP_NAME : await chip.getChipDescription(loader),
        features: secure ? [] : await chip.getChipFeatures(loader),
        crystalMHz: secure ? 0 : await chip.getCrystalFreq(loader),
        mac: secure ? '' : await chip.readMac(loader),
        flashSize: (await loader.detectFlashSize().catch(() => undefined)) ?? null,
      }
      this.info = info
      return info
    } catch (e) {
      await this.closeLoader()
      throw e
    }
  }

  private requireLoader(): ESPLoader {
    if (!this.loader) throw new Error('Not connected to the bootloader')
    return this.loader
  }

  async readMac(): Promise<string> {
    const l = this.requireLoader()
    const mac = await l.chip.readMac(l)
    if (this.info) this.info = { ...this.info, mac }
    return mac
  }

  async erase(): Promise<void> {
    await this.requireLoader().eraseFlash()
  }

  async flash(job: FlashJob): Promise<void> {
    const l = this.requireLoader()
    await l.writeFlash({
      fileArray: job.files,
      flashMode: job.flashMode,
      flashFreq: job.flashFreq,
      flashSize: job.flashSize,
      eraseAll: job.eraseAll,
      compress: job.compress,
      reportProgress: job.onProgress,
      calculateMD5Hash: md5Hex,
    })
  }

  /** Hard-reset the chip into the user application via RTS. */
  async reset(): Promise<void> {
    await this.requireLoader().after('hard_reset')
  }

  /** Leaves the bootloader session and closes the port. */
  async closeLoader(): Promise<void> {
    const t = this.transport
    this.loader = null
    this.transport = null
    if (t) await t.disconnect().catch(() => {})
  }

  /** Reboots the app and streams its serial output. Ends the bootloader session. */
  async startMonitor(baud: number, onData: (text: string) => void, onEnd: () => void): Promise<void> {
    if (!this.port) throw new Error('No port selected')
    const port = this.port
    if (this.loader) {
      try { await this.loader.after('hard_reset') } catch { /* port may be gone */ }
      await this.closeLoader()
    }
    await this.stopMonitor()
    await port.open({ baudRate: baud })
    // Pulse EN via RTS (DTR released) so the app starts from the top.
    await port.setSignals({ dataTerminalReady: false, requestToSend: true }).catch(() => {})
    await new Promise((r) => setTimeout(r, 100))
    await port.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => {})
    const reader = port.readable!.getReader()
    this.monitorReader = reader
    const dec = new TextDecoder()
    this.monitorDone = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value) onData(dec.decode(value, { stream: true }))
        }
      } catch {
        /* device unplugged or reader cancelled */
      } finally {
        reader.releaseLock()
        this.monitorReader = null
        await port.close().catch(() => {})
        onEnd()
      }
    })()
  }

  async sendMonitor(text: string): Promise<void> {
    if (!this.port?.writable || !this.monitorReader) return
    const w = this.port.writable.getWriter()
    try { await w.write(new TextEncoder().encode(text)) } finally { w.releaseLock() }
  }

  async stopMonitor(): Promise<void> {
    const r = this.monitorReader
    if (!r) return
    await r.cancel().catch(() => {})
    await this.monitorDone
    this.monitorDone = null
  }

  async disconnect(): Promise<void> {
    await this.stopMonitor()
    await this.closeLoader()
    this.port = null
    this.info = null
  }
}
