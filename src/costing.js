// 保障开支分账与回单处理：
// - 旅客接受的一份可行改签关闭其他同类报价的报销资格（见 rebooks.js）；
// - 酒店按房结、一房多人共用：按入住旅客拆分责任份额，关联旅客责任未定时其份额暂挂，
//   不得因同房间另一旅客责任确定就把全间分给一家，也不按人头重复支出；
// - 已付给旅客的钱不重付；合作方之间的差额走复议回单；未达到用证条件的部分保持暂挂；
// - 先行垫付后另一家就同一房账申领，只有同一实际住宿（同 receipt+room_key）才能抵消重复申领；
// - 一张回单含多房/多人时，同一费用号不能抹掉真实存在的另一份费用（同 bill 不同 room_key 独立）。
import { num, splitList, round2 } from './util.js'

const ROOM = '房间'
const PAID = '已付旅客'

function fmtCarrier(map) {
  const entries = Object.entries(map)
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join('，') : '无确定责任方'
}

/** 为每张保障收据建立按旅客的责任分摊。 */
export function allocateExpense(expense, rooms, responsibilityByTicket) {
  const tickets = splitList(expense.tickets)
  const cost = num(expense.cost)
  const room = rooms.find(r => r.receipt === expense.receipt) ?? null
  const isRoom = expense.type === ROOM
  const guestCount = isRoom ? tickets.length : tickets.length

  const lines = tickets.map(ticket => {
    const resp = responsibilityByTicket.get(ticket)
    const faceShare = cost / guestCount
    if (!resp || resp.held || Object.keys(resp.shares).length === 0) {
      return {
        ticket,
        faceShare: round2(faceShare),
        held: true,
        carrierShares: {},
        reason: resp?.held
          ? `票证 ${ticket} 责任未定（${resp.status}），份额暂挂，不并入同房其他旅客的责任方`
          : `票证 ${ticket} 缺少责任认定，份额暂挂`,
      }
    }
    return {
      ticket,
      faceShare: round2(faceShare),
      held: false,
      carrierShares: Object.fromEntries(
        Object.entries(resp.shares).map(([carrier, share]) => [carrier, round2(faceShare * share)]),
      ),
      reason: `按 ${resp.rule} 协议「${resp.agreement ?? '?'}」分摊`,
    }
  })

  // 汇总到责任方；尾差并入第一责任方并单独标注
  const carrierTotals = {}
  let heldAmount = 0
  for (const line of lines) {
    if (line.held) {
      heldAmount = round2(heldAmount + line.faceShare)
      continue
    }
    for (const [carrier, amount] of Object.entries(line.carrierShares)) {
      carrierTotals[carrier] = round2((carrierTotals[carrier] ?? 0) + amount)
    }
  }
  const allocatedSum = round2(Object.values(carrierTotals).reduce((a, b) => a + b, 0))
  const roundingRemainder = round2(cost - allocatedSum - heldAmount)
  if (roundingRemainder !== 0) {
    const first = Object.keys(carrierTotals)[0]
    if (first) carrierTotals[first] = round2(carrierTotals[first] + roundingRemainder)
  }

  return {
    receipt: expense.receipt,
    type: expense.type,
    roomKey: room?.room_key ?? null,
    bill: room?.bill ?? null,
    tickets,
    cost,
    state: expense.state,
    paidToPassenger: expense.state === PAID,
    lines,
    carrierTotals,
    heldAmount,
    allocatedAmount: round2(cost - heldAmount),
    roundingRemainder,
  }
}

/** 逐张处理财务回单（含跨期送达、重复申领抵消、复议回单）。 */
export function processClaims(claims, allocations, rooms) {
  const allocByReceipt = new Map(allocations.map(a => [a.receipt, a]))
  const roomByReceipt = new Map(rooms.map(r => [r.receipt, r]))

  return claims.map(claim => {
    const amount = num(claim.amount)
    const tickets = splitList(claim.tickets)
    const allocation = allocByReceipt.get(claim.expense)
    const room = roomByReceipt.get(claim.expense)
    const crossPeriod = claim.service_period !== claim.received_period

    const result = {
      claim: claim.claim,
      expense: claim.expense,
      carrier: claim.carrier,
      tickets,
      amount,
      servicePeriod: claim.service_period,
      receivedPeriod: claim.received_period,
      crossPeriod,
      rawState: claim.state,
      treatment: null,
      advance: 0,      // 先行垫付且已付旅客的现金（不重付）
      payable: 0,      // 本回单本期可签/可付金额（垫付与抵消不计入）
      offset: 0,       // 同一实际住宿的重复申领抵消额
      reviewDelta: 0,  // 合作方之间走复议回单的差额（可正可负）
      held: 0,         // 未达用证条件、保持暂挂的金额
      note: '',
    }

    if (!allocation) {
      result.treatment = 'unmatched'
      result.held = amount
      result.note = `回单引用费用号 ${claim.expense} 在保障收据中不存在，保持暂挂待证`
      return result
    }

    // 同一费用号、同一房号才认定为同一实际住宿；同 bill 不同 room_key 是另一份真实费用
    const sameRoom = room && room.room_key === (roomByReceipt.get(claim.expense)?.room_key ?? null)

    switch (claim.state) {
      case '实付旅客': {
        // 先行垫付且已付旅客：整笔登记为垫付现金；收据的责任归属在分账层另签，
        // 责任未定旅客的份额暂挂；同一笔钱不对旅客、不对合作方重付。
        const ticketHeld = allocation.lines
          .filter(l => l.held && tickets.includes(l.ticket))
          .reduce((sum, l) => round2(sum + l.faceShare), 0)
        result.treatment = 'advance_paid'
        result.advance = amount
        result.payable = 0
        result.held = round2(ticketHeld)
        result.note = `先行垫付已付旅客 ${amount}（登记为垫付，不作第二次付款）；` +
          `收据责任归属见分账：${fmtCarrier(allocation.carrierTotals)}，` +
          `其中责任未定暂挂 ${result.held}`
        break
      }
      case '申领同房': {
        if (!sameRoom) {
          result.treatment = 'separate_room_preserved'
          result.held = amount
          result.note = '房号不一致，属另一份真实费用，不得因同费用号/同账单抹掉，待独立用证'
          break
        }
        // 同一实际住宿的重复申领：仅抵消重复部分，不产生第二次付款
        const alreadyPaid = allocation.paidToPassenger ? amount : 0
        result.treatment = 'duplicate_offset'
        result.offset = round2(alreadyPaid)
        result.payable = 0
        result.note = `与已先行垫付的 ${claim.expense}/${room?.room_key ?? '?'} 为同一实际住宿，` +
          '重复申领予以抵消，不重复支出'
        break
      }
      case '独立房': {
        // 同一账单下的另一间房：真实费用保留，按其自身责任状态签或暂挂
        const target = allocation
        const carrierPart = target.carrierTotals[claim.carrier] ?? 0
        result.treatment = 'separate_room_preserved'
        result.payable = round2(carrierPart)
        result.held = round2(target.heldAmount)
        result.note = `账单 ${target.bill ?? '?'} 下另一房号 ${target.roomKey ?? '?'} 的独立房账，` +
          '真实费用保留，按本房旅客责任分摊，不被同房账单的重复申领抹掉'
        break
      }
      case '合作方结算': {
        // 合作方之间的差额走复议回单：只对可归属差额办理，不触碰旅客已确认份额
        const attributed = tickets.reduce((sum, t) => {
          const line = allocation.lines.find(l => l.ticket === t)
          if (!line || line.held) return sum
          return round2(sum + (line.carrierShares[claim.carrier] ?? 0))
        }, 0)
        const delta = round2(amount - attributed)
        result.treatment = 'partner_review'
        result.reviewDelta = delta
        result.payable = round2(attributed)
        result.note = `合作方结算回单：可归属份额 ${attributed}，申领 ${amount}，` +
          `差额 ${delta} 走复议回单；其余旅客已确认份额不受影响、继续可查可结`
        break
      }
      default:
        result.treatment = 'held_pending'
        result.held = amount
        result.note = `回单状态「${claim.state}」未达到用证条件，保持暂挂`
    }

    if (crossPeriod && result.treatment !== 'unmatched') {
      result.note += `；凭据服务期 ${claim.service_period}、送达期 ${claim.received_period}，按送达期调整入账，原期签数不重开`
    }
    return result
  })
}

/** 按结算周期汇总；无回单的保障收据归入默认服务期。 */
export function buildPeriodLedger(allocations, processedClaims, defaultPeriod = 'P1') {
  const periods = new Map()
  const ensure = p => {
    if (!periods.has(p)) {
      periods.set(p, {
        period: p,
        expenseTotal: 0,
        allocated: 0,
        held: 0,
        paidToPassenger: 0,
        carrierSigned: {},
        sharedExpenses: [],
        openReasons: [],
        claims: [],
        checks: [],
      })
    }
    return periods.get(p)
  }

  // 1) 保障收据按其最早关联回单的服务期归集，无回单用默认期
  const claimByExpense = new Map()
  for (const c of processedClaims) {
    if (!claimByExpense.has(c.expense)) claimByExpense.set(c.expense, c)
  }

  for (const a of allocations) {
    const period = claimByExpense.get(a.receipt)?.servicePeriod ?? defaultPeriod
    const bucket = ensure(period)
    bucket.expenseTotal = round2(bucket.expenseTotal + a.cost)
    bucket.allocated = round2(bucket.allocated + a.allocatedAmount)
    bucket.held = round2(bucket.held + a.heldAmount)
    if (a.paidToPassenger) bucket.paidToPassenger = round2(bucket.paidToPassenger + a.cost)
    for (const [carrier, v] of Object.entries(a.carrierTotals)) {
      bucket.carrierSigned[carrier] = round2((bucket.carrierSigned[carrier] ?? 0) + v)
    }
    if (a.tickets.length > 1) {
      bucket.sharedExpenses.push({
        receipt: a.receipt,
        roomKey: a.roomKey,
        guests: a.tickets,
        cost: a.cost,
        heldGuests: a.lines.filter(l => l.held).map(l => l.ticket),
      })
    }
    for (const line of a.lines) {
      if (line.held) bucket.openReasons.push({ receipt: a.receipt, ticket: line.ticket, reason: line.reason })
    }
  }

  // 2) 回单按送达期入账（跨期只影响送达期的调整列）
  for (const c of processedClaims) {
    const bucket = ensure(c.receivedPeriod)
    bucket.claims.push(c)
  }

  // 3) 核对：总额 = 已归因 + 暂挂；各类回单金额分类闭合；垫付不超过已付旅客金额
  for (const bucket of periods.values()) {
    const componentSum = round2(bucket.allocated + bucket.held)
    bucket.checks.push({
      name: '保障费用总额=已归因+暂挂',
      pass: componentSum === bucket.expenseTotal,
      detail: `${bucket.expenseTotal} = ${bucket.allocated} + ${bucket.held}`,
    })
    const claimAdvance = round2(bucket.claims.reduce((s, c) => s + c.advance, 0))
    const claimPayable = round2(bucket.claims.reduce((s, c) => s + c.payable, 0))
    const claimOffset = round2(bucket.claims.reduce((s, c) => s + c.offset, 0))
    const claimReview = round2(bucket.claims.reduce((s, c) => s + c.reviewDelta, 0))
    const claimHeld = round2(bucket.claims.reduce((s, c) => s + c.held, 0))
    const claimAmounts = round2(bucket.claims.reduce((s, c) => s + c.amount, 0))
    const classified = round2(claimAdvance + claimPayable + claimOffset + claimHeld + claimReview)
    bucket.checks.push({
      name: '回单申领额=垫付+付款+抵消+暂挂+复议差额',
      pass: classified === claimAmounts,
      detail: `申领 ${claimAmounts} = 垫付 ${claimAdvance} + 付款 ${claimPayable} + 抵消 ${claimOffset} + 暂挂 ${claimHeld} + 复议差额 ${claimReview}`,
    })
    bucket.checks.push({
      name: '先行垫付不超过本期已付旅客金额（已付款不重付）',
      pass: claimAdvance <= bucket.paidToPassenger,
      detail: `垫付 ${claimAdvance} <= 已付旅客 ${bucket.paidToPassenger}`,
    })
    bucket.claimAdvance = claimAdvance
    bucket.claimPayable = claimPayable
    bucket.claimOffset = claimOffset
    bucket.claimReview = claimReview
    bucket.claimHeld = claimHeld
  }

  return [...periods.values()].sort((a, b) => a.period.localeCompare(b.period))
}
