// 反事实模拟协议：分别检验消除单项异常、消除异常组合后能否接上原航班。
// 关门/开门基准为绝对分钟；接驳基准为从开门起的分钟差。恰在关门完成仍可衔接。
import { num } from './util.js'
import { evaluateConnection } from './timeline.js'

function parseAffected(affected) {
  const suffix = affected.match(/(开门|关门|接驳)$/)?.[0]
  if (!suffix) throw new Error(`无法解析反事实作用对象: ${affected}`)
  const flight = affected.slice(0, affected.length - suffix.length)
  const event = suffix === '接驳' ? '接驳完成' : suffix
  return { flight, event }
}

/** 取本票证规则下、且作用于本票证前后段航班的反事实证据。 */
export function applicableCounterfactuals(trip, cfRows) {
  return cfRows
    .filter(row => row.rule === trip.rule)
    .map(row => ({ ...row, target: parseAffected(row.affected), reference: num(row.reference) }))
    .filter(row => row.target.flight === trip.inbound || row.target.flight === trip.outbound)
}

function powerSet(items) {
  const sets = [[]]
  for (const item of items) {
    const len = sets.length
    for (let i = 0; i < len; i++) sets.push([...sets[i], item])
  }
  return sets
}

/**
 * 在给定被消除原因集合下重建窗口并判定能否接上。
 * @returns {{eliminated:string[], doorAt:number|null, transfer:{at:number|null,earliest:number|null,latest:number|null}, closeAt:number|null, connectivity:string}}
 */
export function simulate(timeline, cfRows, eliminatedSet) {
  const overrides = new Map()
  for (const raw of cfRows) {
    if (!eliminatedSet.has(raw.cause)) continue
    const row = raw.target ? raw : { ...raw, target: parseAffected(raw.affected), reference: num(raw.reference) }
    overrides.set(`${row.target.flight}|${row.target.event}`, row)
  }

  const baseDoorAt = timeline.events['开门']?.at ?? timeline.events['开门']?.earliest ?? null
  const doorRow = overrides.get(`${timeline.inbound}|开门`)
  const doorAt = doorRow ? doorRow.reference : baseDoorAt

  const transferRow = overrides.get(`${timeline.inbound}|接驳完成`)
  let transfer
  if (transferRow) {
    const value = doorAt === null ? null : doorAt + transferRow.reference
    transfer = { at: value, earliest: value, latest: value }
  } else {
    transfer = { ...timeline.transferWindow }
  }

  const closeRow = overrides.get(`${timeline.outbound}|关门`)
  const closeAt = closeRow ? closeRow.reference : timeline.closeAt

  return {
    eliminated: [...eliminatedSet],
    doorAt,
    transfer,
    closeAt,
    connectivity: transfer.earliest === null && transfer.latest === null
      ? 'unknown'
      : evaluateConnection(transfer, closeAt),
  }
}

/** 枚举全部消除方案并按模拟协议归类。 */
export function runAttribution(timeline, cfRows) {
  const applicable = applicableCounterfactuals(timeline, cfRows)
  const testableCauses = [...new Set(applicable.map(row => row.cause))]

  const baseline = simulate(timeline, applicable, new Set())
  const simulations = []
  for (const subset of powerSet(testableCauses)) {
    if (subset.length === 0) continue
    simulations.push(simulate(timeline, applicable, new Set(subset)))
  }

  // 单项消除即可恢复的独立可恢复方
  const singleSufficient = testableCauses.filter(cause => {
    const sim = simulations.find(s => s.eliminated.length === 1 && s.eliminated[0] === cause)
    return sim?.connectivity === 'yes'
  })

  // 全部最小充分集合（集合内原因必须同时消除才恢复，且无更小子集可恢复）
  const recoverable = simulations.filter(s => s.connectivity === 'yes')
  const minimalSufficientSets = recoverable
    .map(s => new Set(s.eliminated))
    .filter(set => {
      if (set.size === 1) return false // 单项可恢复已归入独立可恢复方
      return !recoverable.some(other => {
        if (other.eliminated.length >= set.size) return false
        return other.eliminated.every(c => set.has(c))
      })
    })
    .map(set => [...set])

  let status
  if (baseline.connectivity === 'yes') {
    status = 'connected' // 实际已接上，无误机责任
  } else if (singleSufficient.length > 0) {
    status = 'single' // 某项延误单独消除即可恢复
  } else if (minimalSufficientSets.length > 0) {
    status = 'combined' // 必须同时消除几项
  } else {
    status = 'unresolved' // 证据不足或互相矛盾：暂挂
  }

  return {
    ticket: timeline.ticket,
    rule: timeline.rule,
    actualConnectivity: baseline.connectivity,
    testableCauses,
    counterfactualEvidence: applicable.map(row => ({
      cause: row.cause,
      affected: row.affected,
      reference: row.reference,
    })),
    singleSufficient,
    minimalSufficientSets,
    simulations,
    status,
  }
}
