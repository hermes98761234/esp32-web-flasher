/** Helpers for the serial monitor: ANSI stripping and line buffering. */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

/**
 * Appends decoded text to a list of lines. A trailing partial line stays open
 * (the last element) until a newline arrives. Keeps at most `max` lines.
 */
export function appendText(lines: string[], chunk: string, max = 2000): string[] {
  const text = stripAnsi(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const parts = text.split('\n')
  const out = lines.length ? lines.slice() : ['']
  out[out.length - 1] += parts[0]
  for (let i = 1; i < parts.length; i++) out.push(parts[i])
  return out.length > max ? out.slice(out.length - max) : out
}
