import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ATTEMPTS = 8
const readText = (directory, name) => { try { return readFileSync(join(directory, name), 'utf8').trim() } catch { return '' } }
const readJson = (directory, name) => { try { return JSON.parse(readFileSync(join(directory, name), 'utf8')) } catch { return null } }

// Optional admin stats for /run posts: WARP outcome, current and final model,
// per-attempt results and elapsed time. Missing files simply omit fields.
export function buildStats(directory, now = Date.now()) {
  if (!directory) return {}
  const stats = {}
  const warp = readJson(directory, 'warp-status.json')
  if (warp && typeof warp === 'object') {
    stats.warp = { decision: warp.decision, result: warp.result }
    for (const key of ['attempt', 'egress_prefix', 'colo']) if (warp[key] !== undefined && warp[key] !== '') stats.warp[key] = warp[key]
  }
  const model = readText(directory, 'main-model')
  if (model) stats.model = model
  const attempts = readJson(directory, 'model-attempts.json')
  if (Array.isArray(attempts) && attempts.length) {
    stats.attempts = attempts.slice(-MAX_ATTEMPTS).map(({ model, outcome, code, error_class, duration_ms }) => ({ model, outcome, code, ...(error_class ? { error_class } : {}), duration_ms }))
    const done = attempts.findLast(attempt => attempt?.code === 0)
    if (done?.model) stats.final_model = done.model
  }
  const started = Number(readText(directory, 'build-started-at'))
  if (Number.isFinite(started) && started > 0 && now >= started) stats.duration_ms = now - started
  return stats
}
