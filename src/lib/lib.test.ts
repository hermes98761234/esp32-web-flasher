import { describe, expect, it } from 'vitest'
import { md5Hex } from './md5.ts'
import { formatBytes, hex, parseOffset } from './format.ts'
import { bootloaderOffset, checkLayout, guessRole, inspectImage, suggestOffset } from './image.ts'
import { chipKey, parseManifest, pickBuild, resolvePartUrl } from './manifest.ts'
import { appendText, stripAnsi } from './monitor.ts'
import { demoFiles } from './demo.ts'
import { tr, UK } from '../i18n.ts'

const enc = (s: string) => new TextEncoder().encode(s)

describe('md5 (RFC 1321 test suite)', () => {
  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
    ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
  ])('md5(%j)', (input, digest) => {
    expect(md5Hex(enc(input))).toBe(digest)
  })
  it('handles block boundaries (55, 56, 64 bytes) and large input', () => {
    expect(md5Hex(new Uint8Array(55).fill(97))).toBe('ef1772b6dff9a122358552954ad0df65')
    expect(md5Hex(new Uint8Array(56).fill(97))).toBe('3b0c8ac703f828b04c6c197006d17218')
    expect(md5Hex(new Uint8Array(64).fill(97))).toBe('014842d480b571495a4a0363793f7367')
    expect(md5Hex(new Uint8Array(1_000_000).fill(97))).toBe('7707d6ae4e027c70eea2a935c2296f21')
  })
})

describe('format', () => {
  it('parses offsets', () => {
    expect(parseOffset('0x1000')).toBe(4096)
    expect(parseOffset(' 0X10000 ')).toBe(65536)
    expect(parseOffset('4096')).toBe(4096)
    expect(parseOffset('64k')).toBe(65536)
    expect(parseOffset('1M')).toBe(1048576)
    expect(parseOffset('0')).toBe(0)
    expect(parseOffset('')).toBeNull()
    expect(parseOffset('-1')).toBeNull()
    expect(parseOffset('0xZZ')).toBeNull()
    expect(parseOffset('0x1ffffffff')).toBeNull()
  })
  it('formats sizes and hex', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.00 MB')
    expect(hex(0x10000)).toBe('0x10000')
  })
})

describe('image inspection', () => {
  it('reads the ESP32-S3 image header', () => {
    const d = new Uint8Array(32)
    d[0] = 0xe9
    d[1] = 4
    d[2] = 2
    d[3] = 0x40
    d[12] = 9
    expect(inspectImage(d)).toEqual({ kind: 'app', segments: 4, flashMode: 'dio', flashSize: '16MB', chip: 'ESP32-S3' })
  })
  it('recognises a partition table and unknown data', () => {
    expect(inspectImage(Uint8Array.of(0xaa, 0x50, 1, 2)).kind).toBe('partition-table')
    expect(inspectImage(Uint8Array.of(1, 2, 3)).kind).toBe('unknown')
  })
  it('guesses roles and offsets', () => {
    const app = demoFiles()[3].data
    expect(guessRole('x.ino.bootloader.bin', app)).toBe('bootloader')
    expect(guessRole('boot_app0.bin', app)).toBe('boot_app0')
    expect(guessRole('x.partitions.bin', app)).toBe('partitions')
    expect(guessRole('firmware.bin', app)).toBe('app')
    expect(suggestOffset('partitions', 'ESP32')).toBe(0x8000)
    expect(suggestOffset('boot_app0', 'ESP32')).toBe(0xe000)
    expect(suggestOffset('app', 'ESP32')).toBe(0x10000)
    expect(suggestOffset('app', 'ESP8266EX')).toBe(0)
  })
  it('uses the esptool bootloader offsets', () => {
    expect(bootloaderOffset('ESP32')).toBe(0x1000)
    expect(bootloaderOffset('ESP32-S2')).toBe(0x1000)
    expect(bootloaderOffset('ESP32-S3')).toBe(0)
    expect(bootloaderOffset('ESP32-C3')).toBe(0)
    expect(bootloaderOffset('ESP32-C6')).toBe(0)
    expect(bootloaderOffset('ESP32-P4')).toBe(0x2000)
    expect(bootloaderOffset('ESP8266')).toBe(0)
  })
})

describe('layout check', () => {
  it('accepts a standard Arduino ESP32 layout', () => {
    const e = [
      { name: 'boot', offset: 0x1000, size: 0x6a00 },
      { name: 'part', offset: 0x8000, size: 0xc00 },
      { name: 'app0', offset: 0xe000, size: 0x2000 },
      { name: 'app', offset: 0x10000, size: 0x31000 },
    ]
    expect(checkLayout(e, 4 * 1024 * 1024)).toEqual([])
  })
  it('flags overlaps, bad offsets, alignment, overflow and empty files', () => {
    const issues = checkLayout(
      [
        { name: 'a', offset: 0x0, size: 0x2000 },
        { name: 'b', offset: 0x1000, size: 0x1000 },
        { name: 'c', offset: null, size: 10 },
        { name: 'd', offset: 0x1234, size: 4 },
        { name: 'e', offset: 0x3ff000, size: 0x2000 },
        { name: 'f', offset: 0x5000, size: 0 },
      ],
      0x400000,
    )
    const msgs = issues.map((i) => `${i.level}:${i.message}:${i.args.join(',')}`)
    expect(msgs).toContain('error:{0} overlaps {1}:b,a')
    expect(msgs).toContain('error:Invalid offset for {0}:c')
    expect(msgs).toContain('warn:{0}: offset is not aligned to 4 KB:d')
    expect(msgs).toContain('error:{0} does not fit in the flash:e')
    expect(msgs).toContain('warn:{0} is empty and will be skipped:f')
  })
  it('allows adjacent files', () => {
    expect(checkLayout([{ name: 'a', offset: 0, size: 0x1000 }, { name: 'b', offset: 0x1000, size: 1 }])).toEqual([])
  })
})

describe('manifest', () => {
  const m = parseManifest({
    name: 'Demo', version: '1.2',
    builds: [
      { chipFamily: 'ESP32', parts: [{ path: 'a.bin', offset: 4096 }] },
      { chipFamily: 'ESP32-S3', parts: [{ path: 'dir/b.bin', offset: 0 }] },
    ],
  })
  it('parses and validates', () => {
    expect(m.name).toBe('Demo')
    expect(m.builds).toHaveLength(2)
    expect(() => parseManifest(null)).toThrow()
    expect(() => parseManifest({ builds: [] })).toThrow('no builds')
    expect(() => parseManifest({ builds: [{ chipFamily: 'ESP32', parts: [{ path: 'x', offset: -1 }] }] })).toThrow('offset')
    expect(() => parseManifest({ builds: [{ parts: [] }] })).toThrow('chipFamily')
  })
  it('picks the build matching the chip', () => {
    expect(chipKey('ESP32-S3 (QFN56) (revision v0.1)')).toBe('ESP32S3')
    expect(pickBuild(m, 'ESP32-S3')?.parts[0].path).toBe('dir/b.bin')
    expect(pickBuild(m, 'ESP32-D0WDQ6')?.parts[0].path).toBe('a.bin')
    expect(pickBuild(m, 'ESP8266')).toBeNull()
    expect(pickBuild(m, null)).toBeNull()
  })
  it('resolves part URLs against the manifest', () => {
    expect(resolvePartUrl('dir/b.bin', 'https://x.test/fw/manifest.json')).toBe('https://x.test/fw/dir/b.bin')
    expect(resolvePartUrl('https://cdn.test/c.bin', 'https://x.test/m.json')).toBe('https://cdn.test/c.bin')
  })
})

describe('monitor text', () => {
  it('strips ANSI colour codes', () => {
    expect(stripAnsi('\x1b[0;32mI (1) boot\x1b[0m')).toBe('I (1) boot')
  })
  it('joins partial lines across chunks and normalises CR/LF', () => {
    let l = appendText([''], 'ets Jun 8 2016\r\nrst:0x1 (POW')
    expect(l).toEqual(['ets Jun 8 2016', 'rst:0x1 (POW'])
    l = appendText(l, 'ERON_RESET)\rready\n')
    expect(l).toEqual(['ets Jun 8 2016', 'rst:0x1 (POWERON_RESET)', 'ready', ''])
  })
  it('caps the number of lines', () => {
    expect(appendText(['a', 'b', 'c'], 'd\ne', 3)).toEqual(['b', 'cd', 'e'])
  })
})

describe('i18n', () => {
  it('interpolates and falls back to English', () => {
    expect(tr('en', '{0} overlaps {1}', 'a', 'b')).toBe('a overlaps b')
    expect(tr('uk', '{0} overlaps {1}', 'a', 'b')).toBe('a перекриває b')
    expect(tr('uk', 'No such string')).toBe('No such string')
  })
  it('keeps placeholders consistent in translations', () => {
    for (const [en, uk] of Object.entries(UK)) {
      expect((uk.match(/\{\d+\}/g) ?? []).sort()).toEqual((en.match(/\{\d+\}/g) ?? []).sort())
    }
  })
})
