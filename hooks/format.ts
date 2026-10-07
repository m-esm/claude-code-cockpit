const TICKS = '▁▂▃▄▅▆▇█'

export const sparkline = (values: readonly number[], max = 10): string =>
  values.map(value => TICKS[Math.max(0, Math.min(TICKS.length - 1, Math.round((value / max) * (TICKS.length - 1))))]).join('')

export const ago = (then: number, now: number): string => {
  if (!then) return 'never'
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

export const until = (iso: string | null, now: number): string => {
  if (!iso) return 'reset unknown'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return 'reset unknown'
  const ms = at - now
  if (ms <= 0) return 'resetting'
  return `resets in ${duration(ms)}`
}

export const clock = (at: number): string => {
  if (!at) return '--:--:--'
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':')
}
