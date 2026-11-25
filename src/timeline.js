// 时间窗口重建：按到位、开门、接驳完成、关门证据重建，未提供的时间以明确上下界表达。
// 同一事件存在多版 revision 时，以最高版本为当前值，同时保留全部版本用于矛盾检验。
import { num, MISSING } from './util.js'

const EVENT_ORDER = ['到位', '开门', '接驳完成', '关门']

function intervalOf(row) {
  const at = num(row.at)
  return {
    at,
    earliest: at ?? num(row.earliest),
    latest: at ?? num(row.latest),
  }
}

function intersects(a, b) {
  // 任一端缺界时不做否定判断
  if (a.earliest === null || a.latest === null || b.earliest === null || b.latest === null) return true
  return !(a.latest < b.earliest || b.latest < a.earliest)
}

/** 把 legs 表整理为 航班 -> 事件 -> 节点（含全部版本与当前版本）。 */
export function buildFlightNodes(legRows) {
  const flights = new Map()
  for (const row of legRows) {
    if (!flights.has(row.flight)) flights.set(row.flight, new Map())
    const events = flights.get(row.flight)
    if (!events.has(row.event)) events.set(row.event, [])
    events.get(row.event).push(row)
  }

  const nodes = new Map()
  const conflicts = []

  for (const [flight, events] of flights) {
    const eventNodes = new Map()
    for (const [event, rows] of events) {
      const revisions = rows
        .map(row => ({ revision: num(row.revision), cause: row.cause, ...intervalOf(row) }))
        .sort((a, b) => a.revision - b.revision)

      // 同事件各版本的区间必须相交，否则证据互相矛盾
      for (let i = 1; i < revisions.length; i++) {
        if (!intersects(revisions[i - 1], revisions[i])) {
          conflicts.push({
            kind: 'revision_interval_disjoint',
            flight,
            event,
            revisions: [revisions[i - 1].revision, revisions[i].revision],
            intervals: [
              { earliest: revisions[i - 1].earliest, latest: revisions[i - 1].latest },
              { earliest: revisions[i].earliest, latest: revisions[i].latest },
            ],
          })
        }
      }

      const current = revisions[revisions.length - 1]
      eventNodes.set(event, { flight, event, revisions, current })
    }
    nodes.set(flight, eventNodes)
  }

  // 同一航班事件先后顺序检验：早事件的最早界晚于晚事件的最晚界即顺序矛盾
  for (const [flight, events] of nodes) {
    const ordered = EVENT_ORDER.filter(e => events.has(e)).map(e => events.get(e))
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i].current
      const b = ordered[i + 1].current
      if (a.earliest !== null && b.latest !== null && a.earliest > b.latest) {
        conflicts.push({
          kind: 'event_order_contradiction',
          flight,
          earlier: ordered[i].event,
          later: ordered[i + 1].event,
          earlierEarliest: a.earliest,
          laterLatest: b.latest,
        })
      }
    }
  }

  return { nodes, conflicts }
}

/**
 * 判定接驳窗口与关门的关系。恰在关门时完成仍可衔接（<=）。
 * @returns {'yes'|'no'|'unknown'} yes=确定接上，no=确定赶不上，unknown=区间内两种可能
 */
export function evaluateConnection(transfer, closeAt) {
  if (closeAt === null) return 'unknown'
  const { earliest, latest } = transfer
  if (latest !== null && latest <= closeAt) return 'yes'
  if (earliest !== null && earliest > closeAt) return 'no'
  return 'unknown'
}

/** 组装单张票证的时间线（前段各事件 + 后段关门）。 */
export function buildTripTimeline(trip, flightNodes) {
  const inbound = flightNodes.get(trip.inbound) ?? new Map()
  const outbound = flightNodes.get(trip.outbound) ?? new Map()
  const pick = (map, event) => map.get(event)?.current ?? null

  const arrival = pick(inbound, '到位')
  const door = pick(inbound, '开门')
  const transfer = pick(inbound, '接驳完成')
  const close = pick(outbound, '关门')

  const transferWindow = transfer
    ? { at: transfer.at, earliest: transfer.earliest, latest: transfer.latest }
    : { at: null, earliest: null, latest: null }
  const closeAt = close ? close.at ?? close.latest : null

  const connectivity = transfer.earliest === null && transfer.latest === null
    ? 'unknown'
    : evaluateConnection(transferWindow, closeAt)

  // 实际接驳耗时窗口（相对开门），用于报告解释
  const transferOffset = door && door.at !== null
    ? {
        earliest: transferWindow.earliest !== null ? transferWindow.earliest - door.at : null,
        latest: transferWindow.latest !== null ? transferWindow.latest - door.at : null,
        at: transferWindow.at !== null ? transferWindow.at - door.at : null,
      }
    : { at: null, earliest: null, latest: null }

  const minTransfer = num(trip.min_transfer)
  // 以开门到关门的可支配窗口与公布的最短衔接条件对照（票证保护义务的预先认定口径）
  const doorCloseWindow = door && door.at !== null && closeAt !== null ? closeAt - door.at : null
  const mctProtected = doorCloseWindow === null
    ? null
    : doorCloseWindow >= minTransfer

  return {
    ticket: trip.ticket,
    group: trip.group,
    carrier: trip.carrier,
    rule: trip.rule,
    minTransfer,
    inbound: trip.inbound,
    outbound: trip.outbound,
    events: {
      到位: arrival ? { ...arrival } : null,
      开门: door ? { ...door } : null,
      接驳完成: transfer ? { ...transfer } : null,
      关门: close ? { ...close } : null,
    },
    transferWindow,
    transferOffset,
    closeAt,
    doorCloseWindow,
    mctProtected,
    connectivity,
    missing: EVENT_ORDER.filter(event => {
      const node = event === '关门' ? outbound.get(event) : inbound.get(event)
      if (!node) return true
      return node.current.at === null && (node.current.earliest === null || node.current.latest === null)
    }),
  }
}

export { MISSING }
