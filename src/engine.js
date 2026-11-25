// 引擎总装：读取资料 → 时间窗口重建 → 反事实归因 → 改签认定 → 保障开支分账 → 回单/周期台账。
import { loadTables } from './data.js'
import { buildFlightNodes, buildTripTimeline } from './timeline.js'
import { runAttribution } from './simulation.js'
import { buildResponsibility } from './responsibility.js'
import { buildRebookStatus } from './rebooks.js'
import { allocateExpense, processClaims, buildPeriodLedger } from './costing.js'
import { num, splitList, round2 } from './util.js'

/** 为只出现在房账/回单、未进 expenses 表的房间合成独立费用（按房账自身凭据）。 */
function synthRoomOnlyExpenses(tables, knownReceipts) {
  return tables.rooms
    .filter(r => !knownReceipts.has(r.receipt))
    .map(r => ({
      receipt: r.receipt,
      type: '房间',
      tickets: r.guests,
      cost: r.amount,
      state: '待核', // 无旅客付款收据，未达到用证条件前不视为已付
      synthetic: true,
    }))
}

export async function run(dataDir) {
  const tables = await loadTables(dataDir)
  const { nodes: flightNodes, conflicts: timelineConflicts } = buildFlightNodes(tables.legs)

  // 1) 逐票证：时间线、反事实归因、责任份额、改签认定
  const tickets = []
  for (const trip of tables.trips) {
    const timeline = buildTripTimeline(trip, flightNodes)
    const attribution = runAttribution(timeline, tables.counterfactual)
    const responsibility = buildResponsibility(attribution, tables.agreements)
    const rebook = buildRebookStatus(trip, tables.rebooks, tables.rebook_updates, flightNodes)
    tickets.push({ trip, timeline, attribution, responsibility, rebook })
  }
  const responsibilityByTicket = new Map(tickets.map(t => [t.trip.ticket, t.responsibility]))

  // 2) 保障开支分账（含仅房账房间）
  const knownReceipts = new Set(tables.expenses.map(e => e.receipt))
  const extraExpenses = synthRoomOnlyExpenses(tables, knownReceipts)
  const allExpenses = [...tables.expenses, ...extraExpenses]
  const allocations = allExpenses.map(e => allocateExpense(e, tables.rooms, responsibilityByTicket))

  // 3) 回单处理与周期台账
  const processedClaims = processClaims(tables.accounting, allocations, tables.rooms)
  const ledger = buildPeriodLedger(allocations, processedClaims)

  // 4) 冲突证据汇总：时间线矛盾 + 暂挂原因 + 未提供时间项
  const evidenceConflicts = [
    ...timelineConflicts,
    ...tickets.flatMap(t =>
      t.timeline.missing.map(event => ({
        kind: 'missing_event_evidence',
        ticket: t.trip.ticket,
        flight: event === '关门' ? t.trip.outbound : t.trip.inbound,
        event,
      })),
    ),
  ]

  // 5) 改签补偿汇总（只签实际已过承运节点的接受改签）
  const rebookSummary = tickets.map(t => ({
    ticket: t.trip.ticket,
    acceptedRebook: t.rebook.acceptedRebook,
    recognizedCompensation: t.rebook.recognizedCompensation,
    spentRecognized: t.rebook.spentRecognized,
    misconnectAfterRebook: t.rebook.misconnectAfterRebook,
  }))

  return {
    tickets,
    allocations,
    extraExpenses,
    processedClaims,
    ledger,
    evidenceConflicts,
    rebookSummary,
    totals: summarize(ledger),
  }
}

function summarize(ledger) {
  const expenseTotal = round2(ledger.reduce((s, p) => s + p.expenseTotal, 0))
  const allocated = round2(ledger.reduce((s, p) => s + p.allocated, 0))
  const held = round2(ledger.reduce((s, p) => s + p.held, 0))
  const paidToPassenger = round2(ledger.reduce((s, p) => s + p.paidToPassenger, 0))
  const carrierSigned = {}
  for (const p of ledger) {
    for (const [c, v] of Object.entries(p.carrierSigned)) {
      carrierSigned[c] = round2((carrierSigned[c] ?? 0) + v)
    }
  }
  return { expenseTotal, allocated, held, paidToPassenger, carrierSigned }
}

export { splitList, num }
