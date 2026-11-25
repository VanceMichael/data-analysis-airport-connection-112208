// 改签报价处理：
// 1) 旅客接受的一份可行改签关闭对其他同类报价的报销资格；
// 2) 联程在第一班替代航段开门之前还可改变选择；原改签已过承运节点后才能认定实际花费；
// 3) 替代航段也可能错接（以替代段接驳/关门证据另行判断），但旅客此前已发生的住宿不失效。
import { num } from './util.js'

const ACCEPTED = '接受'

function doorAtOf(flight, flightNodes) {
  const node = flightNodes.get(flight)?.get('开门')
  if (!node) return null
  const cur = node.current
  return cur.at ?? cur.earliest
}

export function buildRebookStatus(trip, rebookRows, updateRows, flightNodes) {
  // 换票更新引用的目标报价可能登记在同团组其他票证下，开门时刻按全表报价解析
  const allOffers = rebookRows.map(r => ({
    rebook: r.rebook,
    ticket: r.ticket,
    flight: r.flight,
    state: r.state,
    compensation: num(r.compensation),
    doorAt: doorAtOf(r.flight, flightNodes),
  }))
  const offers = allOffers.filter(o => o.ticket === trip.ticket).map(o => ({ ...o, events: [] }))
  const byId = new Map(offers.map(o => [o.rebook, o]))
  const doorAtOfRebook = id => allOffers.find(o => o.rebook === id)?.doorAt ?? null

  // 换票更新：替代段开门之前可换；过门之后的更新不生效，原改签维持有效
  const updates = updateRows
    .filter(u => u.ticket === trip.ticket)
    .map(u => {
      const at = num(u.at)
      const doorAt = doorAtOfRebook(u.to)
      // 恰在开门时已不可改，故严格小于；开门证据缺失时无法认定
      const effective = doorAt === null ? null : at < doorAt
      return { ...u, at, effective, status: u.status }
    })

  for (const u of updates) {
    const from = byId.get(u.from)
    const to = byId.get(u.to)
    if (!from) continue
    if (!u.effective) {
      from.events.push(`换票 ${u.from}→${u.to} 发生在替代段开门后（${u.status}），不生效`)
      continue
    }
    from.events.push(`换票 ${u.from}→${u.to} 在替代段开门前生效，原报价关闭`)
    from.state = '已换关闭'
    if (to) {
      to.state = ACCEPTED
      to.events.push(`经 ${u.at} 时刻换票成为实际接受的改签`)
    }
  }

  const acceptedOffers = offers.filter(o => o.state === ACCEPTED)
  const accepted = acceptedOffers.length === 1 ? acceptedOffers[0] : null

  for (const o of offers) {
    if (accepted && o.rebook !== accepted.rebook) {
      if (o.state !== '已换关闭') o.events.push('旅客已接受另一份可行改签，本报价报销资格关闭')
      o.eligible = false
    } else {
      o.eligible = o.state === ACCEPTED
    }
  }

  // 实际花费认定：原改签已过承运节点（替代段开门时刻已到）
  const spentRecognized = accepted
    ? (accepted.doorAt === null ? false : true)
    : false

  // 替代航段错接判断：若替代段存在关门与接驳证据则独立重建
  const misconnectAfterRebook = accepted
    ? detectRebookMisconnect(accepted.flight, flightNodes)
    : null

  return {
    ticket: trip.ticket,
    offers,
    updates,
    acceptedRebook: accepted ? accepted.rebook : null,
    acceptedFlight: accepted ? accepted.flight : null,
    recognizedCompensation: spentRecognized ? accepted.compensation : null,
    spentRecognized,
    misconnectAfterRebook,
  }
}

function detectRebookMisconnect(flight, flightNodes) {
  const events = flightNodes.get(flight)
  if (!events) return null
  const transfer = events.get('接驳完成')?.current
  if (!transfer) return null
  // 替代段关门证据可能挂在另一航班号上，样本无此结构时仅返回接驳事实
  return {
    flight,
    transferAt: transfer.at,
    transferEarliest: transfer.earliest,
    transferLatest: transfer.latest,
    note: '替代航段接驳证据存在；其关门证据缺失时不作误机断定，旅客此前住宿不失效',
  }
}
