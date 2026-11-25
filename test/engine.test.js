import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from '../src/engine.js'
import { buildFlightNodes, evaluateConnection, buildTripTimeline } from '../src/timeline.js'
import { runAttribution, simulate } from '../src/simulation.js'
import { buildResponsibility } from '../src/responsibility.js'
import { allocateExpense, processClaims } from '../src/costing.js'

const result = await run()
const ticketById = new Map(result.tickets.map(t => [t.trip.ticket, t]))

test('G1 误机：实际窗口按最高版本重建，恰在关门完成才算接上', () => {
  const a1 = ticketById.get('A1')
  assert.equal(a1.timeline.connectivity, 'no')
  assert.equal(a1.timeline.transferWindow.at, 756) // rev2 精确值覆盖 rev1 区间
  assert.equal(a1.timeline.closeAt, 751)
  assert.equal(evaluateConnection({ at: null, earliest: 751, latest: 751 }, 751), 'yes')
  assert.equal(evaluateConnection({ at: null, earliest: 752, latest: 760 }, 751), 'no')
  assert.equal(evaluateConnection({ at: null, earliest: 748, latest: 766 }, 751), 'unknown')
})

test('rev1 区间与 rev2 精确值相交时不算证据矛盾（属细化）', () => {
  const kinds = result.evidenceConflicts.map(c => c.kind)
  assert.ok(!kinds.includes('revision_interval_disjoint'))
  assert.ok(!kinds.includes('event_order_contradiction'))
})

test('G1 反事实：C1 单项消除不能恢复，机场与 C2 为独立可恢复方', () => {
  const a1 = ticketById.get('A1')
  assert.deepEqual(a1.attribution.testableCauses.sort(), ['C1', 'C2', '机场'])
  const byElim = key => a1.attribution.simulations
    .find(s => s.eliminated.length === 1 && s.eliminated[0] === key)
  assert.equal(byElim('C1').connectivity, 'no')   // 开门 722 但接驳仍 756 > 751
  assert.equal(byElim('机场').connectivity, 'yes') // 接驳变为开门后 10 分钟
  assert.equal(byElim('C2').connectivity, 'yes')  // 关门延至 759
  assert.deepEqual(a1.attribution.singleSufficient.sort(), ['C2', '机场'])
  assert.equal(a1.attribution.status, 'single')
})

test('G1 责任份额：独立可恢复方均分，C1 不参与', () => {
  const a1 = ticketById.get('A1')
  assert.deepEqual(a1.responsibility.shares, { 机场: 0.5, C2: 0.5 })
  assert.equal(a1.responsibility.held, false)
  // 同团组 A2 同票证规则、同航班，结论一致
  assert.deepEqual(ticketById.get('A2').responsibility.shares, { 机场: 0.5, C2: 0.5 })
})

test('G2 实际接上：无误机责任，待选改签与待核费用均不签', () => {
  const a3 = ticketById.get('A3')
  assert.equal(a3.timeline.connectivity, 'yes')
  assert.equal(a3.attribution.status, 'connected')
  assert.deepEqual(a3.responsibility.shares, {})
  assert.equal(a3.rebook.spentRecognized, false)
  assert.equal(a3.rebook.recognizedCompensation, null)
})

test('G3 误机但无反事实证据：责任未定，按协议暂挂', () => {
  const a4 = ticketById.get('A4')
  assert.equal(a4.timeline.connectivity, 'no')
  assert.deepEqual(a4.attribution.testableCauses, [])
  assert.equal(a4.attribution.status, 'unresolved')
  assert.equal(a4.responsibility.held, true)
})

test('改签：替代段开门前可换，过门后换票不生效，原改签锁定实际花费', () => {
  const a1 = ticketById.get('A1')
  assert.equal(a1.rebook.acceptedRebook, 'B2') // 810 < F8 开门 815，换票生效
  assert.equal(a1.rebook.recognizedCompensation, 55)
  const a2 = ticketById.get('A2')
  assert.equal(a2.rebook.acceptedRebook, 'B3') // 830 > F9 开门 820，过门未换
  assert.equal(a2.rebook.recognizedCompensation, 60)
  const a2Update = a2.rebook.updates[0]
  assert.equal(a2Update.effective, false) // 目标 B2/F8 开门 815，830 明确过门，非无法认定
  // 被接受改签关闭的报价不可报销
  const b1 = a1.rebook.offers.find(o => o.rebook === 'B1')
  assert.equal(b1.eligible, false)
})

test('酒店按房结：同房两人各按自身责任分摊，不把全间判给一家、不按人头重复', () => {
  const e1 = result.allocations.find(a => a.receipt === 'E1')
  assert.equal(e1.cost, 240)
  assert.equal(e1.tickets.length, 2)
  assert.deepEqual(e1.lines.map(l => l.faceShare), [120, 120])
  assert.deepEqual(e1.carrierTotals, { 机场: 120, C2: 120 })
  assert.equal(e1.heldAmount, 0)
  // 每名旅客份额内再按责任方均分：120 * 0.5 = 60
  assert.equal(e1.lines[0].carrierShares['C2'], 60)
})

test('责任未定旅客的份额暂挂，不并入同房已确定责任的一方', () => {
  const e3 = result.allocations.find(a => a.receipt === 'E3')
  assert.equal(e3.heldAmount, 40)
  assert.equal(e3.allocatedAmount, 0)
  assert.deepEqual(e3.carrierTotals, {})
  const e1b = result.allocations.find(a => a.receipt === 'E1B')
  assert.equal(e1b.heldAmount, 160)
  assert.equal(e1b.roomKey, 'RM-B') // 同账单 Z9 下的独立房间
})

test('回单 Q1：先行垫付登记为垫付现金，可签归属与垫付分离且不重付', () => {
  const q1 = result.processedClaims.find(c => c.claim === 'Q1')
  assert.equal(q1.treatment, 'advance_paid')
  assert.equal(q1.advance, 240)
  assert.equal(q1.payable, 0)
})

test('回单 Q2：同一实际住宿（同收据同房号）的重复申领仅抵消，不二次付款', () => {
  const q2 = result.processedClaims.find(c => c.claim === 'Q2')
  assert.equal(q2.treatment, 'duplicate_offset')
  assert.equal(q2.offset, 120)
  assert.equal(q2.payable, 0)
})

test('回单 Q3：同账单不同房号是另一份真实费用，不得被同费用号抹掉', () => {
  const q3 = result.processedClaims.find(c => c.claim === 'Q3')
  assert.equal(q3.treatment, 'separate_room_preserved')
  assert.equal(q3.held, 160) // 房内旅客 A4 责任未定，全额暂挂而非抵消
  assert.equal(q3.offset, 0)
})

test('回单 Q4：合作方结算只对可归属差额走复议，已确认份额不动', () => {
  const q4 = result.processedClaims.find(c => c.claim === 'Q4')
  assert.equal(q4.treatment, 'partner_review')
  assert.equal(q4.payable, 60) // A1 份额内 C2 责任：120 * 0.5
  assert.equal(q4.reviewDelta, 10) // 申领 70 - 可归属 60
})

test('跨期凭据：服务期与送达期分离，原期签数不重开', () => {
  for (const id of ['Q2', 'Q3', 'Q4']) {
    const c = result.processedClaims.find(x => x.claim === id)
    assert.equal(c.crossPeriod, true)
    assert.equal(c.servicePeriod, 'P1')
    assert.equal(c.receivedPeriod, 'P2')
  }
  const p1 = result.ledger.find(p => p.period === 'P1')
  const p2 = result.ledger.find(p => p.period === 'P2')
  assert.equal(p1.claims.length, 1) // P1 只有当期送达的 Q1
  assert.equal(p2.claims.length, 3)
})

test('周期台账：总额=已归因+暂挂，回单分类闭合，垫付不超过已付旅客', () => {
  for (const p of result.ledger) {
    for (const ch of p.checks) assert.equal(ch.pass, true, `${p.period} ${ch.name}: ${ch.detail}`)
  }
  const p1 = result.ledger.find(p => p.period === 'P1')
  assert.equal(p1.expenseTotal, 485)
  assert.equal(p1.allocated, 240)
  assert.equal(p1.held, 245)
  assert.equal(p1.claimAdvance, 240)
  assert.equal(p1.paidToPassenger, 280)
})

test('未知时间用上下界：仅靠最后到达不能断定可控段，区间跨越关门判 unknown', () => {
  const legRows = [
    { flight: 'X1', event: '开门', at: '100', earliest: '100', latest: '100', revision: '1', cause: 'C1' },
    { flight: 'X1', event: '接驳完成', at: '?', earliest: '120', latest: '140', revision: '1', cause: '?' },
    { flight: 'X2', event: '关门', at: '130', earliest: '130', latest: '130', revision: '1', cause: 'C2' },
  ]
  const { nodes } = buildFlightNodes(legRows)
  const timeline = buildTripTimeline(
    { ticket: 'T', group: 'G', inbound: 'X1', outbound: 'X2', carrier: 'C1', rule: 'K1', min_transfer: '10' },
    nodes,
  )
  assert.equal(timeline.connectivity, 'unknown')
})

test('证据矛盾：同事件两版区间不相交时产生冲突记录', () => {
  const legRows = [
    { flight: 'Y1', event: '接驳完成', at: '?', earliest: '100', latest: '110', revision: '1', cause: '?' },
    { flight: 'Y1', event: '接驳完成', at: '130', earliest: '130', latest: '130', revision: '2', cause: '?' },
  ]
  const { conflicts } = buildFlightNodes(legRows)
  assert.ok(conflicts.some(c => c.kind === 'revision_interval_disjoint'))
})

test('组合责任：无任何单项可恢复、必须同时消除两项时按必要责任方均分', () => {
  const timeline = {
    ticket: 'T', group: 'G', inbound: 'X1', outbound: 'X2', rule: 'K9',
    events: {
      '开门': { at: 100, earliest: 100, latest: 100 },
      '接驳完成': { at: 130, earliest: 130, latest: 130 },
    },
    transferWindow: { at: 130, earliest: 130, latest: 130 },
    closeAt: 105,
  }
  const cfRows = [
    { rule: 'K9', cause: 'C1', affected: 'X1开门', reference: 90 },
    { rule: 'K9', cause: '机场', affected: 'X1接驳', reference: 12 },
  ]
  const attribution = runAttribution(timeline, cfRows)
  assert.equal(attribution.status, 'combined')
  const agreements = [{ rule: 'K9', single: '独立可恢复方均分', combined: '必要责任方均分', unresolved: '暂挂' }]
  const resp = buildResponsibility(attribution, agreements)
  assert.deepEqual(resp.shares, { C1: 0.5, 机场: 0.5 })
  // 校验：单独消除 C1 → 接驳 90+30=120 > 105；单独消除机场 → 100+12=112 > 105；组合 → 90+12=102 ≤ 105
  const s1 = simulate(timeline, cfRows, new Set(['C1']))
  const s2 = simulate(timeline, cfRows, new Set(['机场']))
  assert.equal(s1.connectivity, 'no')
  assert.equal(s2.connectivity, 'no')
  assert.equal(simulate(timeline, cfRows, new Set(['C1', '机场'])).connectivity, 'yes')
})

test('未提供反事实证据的误机一律暂挂，不分给任何航司', () => {
  const alloc = allocateExpense(
    { receipt: 'EX', type: '餐食', tickets: 'A4', cost: '40', state: '已付旅客' },
    [],
    new Map([['A4', ticketById.get('A4').responsibility]]),
  )
  assert.equal(alloc.heldAmount, 40)
  assert.deepEqual(alloc.carrierTotals, {})
})

test('无匹配费用号的回单保持暂挂，不做抵消或付款', () => {
  const claims = [{
    claim: 'QZ', expense: 'NOPE', carrier: 'C2', tickets: 'A1', amount: '99',
    service_period: 'P1', received_period: 'P1', state: '申领同房',
  }]
  const [out] = processClaims(claims, result.allocations, [])
  assert.equal(out.treatment, 'unmatched')
  assert.equal(out.held, 99)
  assert.equal(out.payable, 0)
  assert.equal(out.offset, 0)
})
