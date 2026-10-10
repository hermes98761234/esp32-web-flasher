/** Synthetic placeholder images so the page is meaningful without hardware. Not real firmware. */

function image(size: number, chipId: number, seed: number): Uint8Array {
  const d = new Uint8Array(size)
  d[0] = 0xe9
  d[1] = 3
  d[2] = 2 // dio
  d[3] = 0x20 // 4MB, 40m
  d[12] = chipId & 255
  d[13] = chipId >> 8
  let x = seed
  for (let i = 24; i < size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    d[i] = x >>> 24
  }
  return d
}

export interface DemoFile { name: string; offset: number; data: Uint8Array }

export function demoFiles(): DemoFile[] {
  const pt = new Uint8Array(0xc00)
  pt[0] = 0xaa
  pt[1] = 0x50
  return [
    { name: 'bootloader.bin', offset: 0x1000, data: image(0x6a00, 0, 1) },
    { name: 'partitions.bin', offset: 0x8000, data: pt },
    { name: 'boot_app0.bin', offset: 0xe000, data: image(0x2000, 0, 2) },
    { name: 'firmware.bin', offset: 0x10000, data: image(0x31000, 0, 3) },
  ]
}
