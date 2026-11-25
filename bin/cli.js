#!/usr/bin/env node
// 联程误机归因与保障成本复议工具（只读输入、可重复运行）。
import { run } from '../src/engine.js'
import { clock } from '../src/util.js'

function parseArgs(argv) {
  const args = { _: [], dataDir: undefined, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--data') args.dataDir = argv[++i]
    else if (a === '--json') args.json = true
    else if (a === '--period') args.period = argv[++i]
    else args._.push(a)
  }
  return args
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

function header(title) {
  process.stdout.write(`\n=== ${title} ===\n`)
}

function renderTicket(result) {
  const { trip, timeline, attribution, responsibility, rebook } = result
  header(`票证 ${trip.ticket}（团组 ${trip.group}，${trip.inbound}→${trip.outbound}，规则 ${trip.rule}，最短衔接 ${trip.min_transfer} 分钟）`)

  process.stdout.write('时间窗口重建（分钟 / 时钟）：\n')
  for (const [event, node] of Object.entries(timeline.events)) {
    if (!node) {
      process.stdout.write(`  - ${event}: 无证据\n`)
      continue
    }
    const at = node.at === null ? '?' : `${node.at}(${clock(node.at)})`
    const range = node.at === null ? ` 上下界 [${node.earliest ?? '?'}~${node.latest ?? '?'}]` : ''
    process.stdout.write(`  - ${event}: ${at}${range} 责任来源=${node.cause} rev=${node.revision}\n`)
  }
  process.stdout.write(`实际衔接判定: ${labelConnectivity(timeline.connectivity)}；`)
  process.stdout.write(`开门至关门窗口 ${timeline.doorCloseWindow ?? '?'} 分钟；MCT 保护: ${labelTri(timeline.mctProtected)}\n`)

  process.stdout.write('反事实模拟：\n')
  process.stdout.write(`  可检验原因: ${attribution.testableCauses.join('、') || '（无）'}\n`)
  for (const s of attribution.simulations) {
    process.stdout.write(`  - 消除 [${s.eliminated.join('+') || '无'}] → 开门 ${s.doorAt ?? '?'} ` +
      `接驳[${s.transfer.earliest ?? '?'}~${s.transfer.latest ?? '?'}] 关门 ${s.closeAt ?? '?'} ` +
      `判定 ${labelConnectivity(s.connectivity)}\n`)
  }
  process.stdout.write(`责任归类: ${labelStatus(attribution.status)}\n`)
  process.stdout.write(`责任份额: ${fmtShares(responsibility.shares)}${responsibility.held ? '（暂挂）' : ''}\n`)
  for (const r of responsibility.reasons) process.stdout.write(`  说明: ${r}\n`)

  process.stdout.write('改签与实际花费：\n')
  for (const o of rebook.offers) {
    process.stdout.write(`  - ${o.rebook} 航班 ${o.flight} 状态=${o.state} 补偿=${o.compensation} ` +
      `可报销=${o.eligible ? '是' : '否'} 开门=${o.doorAt ?? '?'}\n`)
    for (const e of o.events) process.stdout.write(`      · ${e}\n`)
  }
  for (const u of rebook.updates) {
    process.stdout.write(`  换票 ${u.from}→${u.to} @${u.at}（${u.status}）生效=${labelTri(u.effective)}\n`)
  }
  process.stdout.write(`实际接受改签: ${rebook.acceptedRebook ?? '无'}；承运节点已过、花费认定=${rebook.spentRecognized ? '是' : '否'}；`)
  process.stdout.write(`可签补偿=${rebook.recognizedCompensation ?? '暂不签'}\n`)
  if (rebook.misconnectAfterRebook) {
    process.stdout.write(`替代航段提示: ${rebook.misconnectAfterRebook.note}\n`)
  }
}

function renderAllocation(a) {
  process.stdout.write(`  收据 ${a.receipt} [${a.type}] 房号=${a.roomKey ?? '-'} 账单=${a.bill ?? '-'} ` +
    `旅客=${a.tickets.join('+')} 金额=${a.cost} 状态=${a.state}${a.paidToPassenger ? '（已付旅客，不重付）' : ''}\n`)
  for (const line of a.lines) {
    process.stdout.write(`    · ${line.ticket} 面额份额=${line.faceShare} ` +
      `${line.held ? '暂挂' : '分摊=' + fmtShares(line.carrierShares)} — ${line.reason}\n`)
  }
  process.stdout.write(`    汇总: 已归因 ${a.allocatedAmount}（${fmtShares(a.carrierTotals)}），暂挂 ${a.heldAmount}，尾差 ${a.roundingRemainder}\n`)
}

function renderLedger(ledger) {
  for (const period of ledger) {
    header(`结算周期 ${period.period}`)
    process.stdout.write(`保障费用总额=${period.expenseTotal} 已归因=${period.allocated} 暂挂=${period.held} 已付旅客=${period.paidToPassenger}\n`)
    process.stdout.write(`各责任方已签: ${fmtShares(period.carrierSigned)}\n`)
    if (period.sharedExpenses.length) {
      process.stdout.write('共同费用（按房结）：\n')
      for (const s of period.sharedExpenses) {
        process.stdout.write(`  - ${s.receipt}/${s.roomKey} 入住=${s.guests.join('+')} 金额=${s.cost} ` +
          `暂挂旅客=${s.heldGuests.join('+') || '无'}\n`)
      }
    }
    process.stdout.write('回单处理：\n')
    for (const c of period.claims) {
      process.stdout.write(`  - ${c.claim} 费用号=${c.expense} 方=${c.carrier} 申领=${c.amount} ` +
        `处理=${labelTreatment(c.treatment)} 垫付=${c.advance} 付款=${c.payable} 抵消=${c.offset} ` +
        `复议差额=${c.reviewDelta} 暂挂=${c.held}` +
        `${c.crossPeriod ? ` 跨期(${c.servicePeriod}服务/${c.receivedPeriod}送达)` : ''}\n`)
      process.stdout.write(`      ${c.note}\n`)
    }
    if (period.openReasons.length) {
      process.stdout.write('未结原因：\n')
      for (const r of period.openReasons) process.stdout.write(`  - ${r.receipt}/${r.ticket}: ${r.reason}\n`)
    }
    process.stdout.write('核对：\n')
    for (const ch of period.checks) process.stdout.write(`  - [${ch.pass ? '通过' : '失败'}] ${ch.name}: ${ch.detail}\n`)
  }
}

function labelConnectivity(v) {
  return v === 'yes' ? '可衔接' : v === 'no' ? '赶不上' : '证据不足（区间两种可能）'
}
function labelStatus(v) {
  return { connected: '实际接上（无责任）', single: '单项消除可恢复（独立可恢复方均分）',
    combined: '必须组合消除（必要责任方均分）', unresolved: '证据不足/矛盾（暂挂）' }[v] ?? v
}
function labelTri(v) {
  if (v === null || v === undefined) return '无法认定'
  return v ? '是' : '否'
}
function labelTreatment(v) {
  return { advance_paid: '先行垫付已付旅客', duplicate_offset: '同房重复申领抵消',
    separate_room_preserved: '独立房账保留', partner_review: '合作方复议回单',
    held_pending: '暂挂待证', unmatched: '费用号无匹配（暂挂）' }[v] ?? v
}
function fmtShares(shares) {
  const entries = Object.entries(shares)
  if (!entries.length) return '无'
  return entries.map(([k, v]) => `${k}=${v}`).join('，')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]
  const result = await run(args.dataDir)

  switch (command) {
    case 'ticket': {
      const id = args._[1]
      const t = result.tickets.find(x => x.trip.ticket === id)
      if (!t) throw new Error(`未找到票证 ${id}`)
      if (args.json) {
        printJson({ ticket: t.trip, timeline: t.timeline, attribution: t.attribution,
          responsibility: t.responsibility, rebook: t.rebook,
          conflicts: result.evidenceConflicts.filter(c => c.ticket === id) })
      } else {
        renderTicket(t)
        const related = result.evidenceConflicts.filter(c => c.ticket === id)
        header(`票证 ${id} 冲突/缺口证据`)
        if (!related.length) process.stdout.write('无矛盾证据；缺失项已在时间线中标注。\n')
        else printJson(related)
      }
      break
    }
    case 'periods': {
      const ledger = args.period ? result.ledger.filter(p => p.period === args.period) : result.ledger
      if (args.json) printJson(ledger)
      else renderLedger(ledger)
      break
    }
    case 'diff': {
      const from = args._[1]
      const to = args._[2]
      const a = result.ledger.find(p => p.period === from)
      const b = result.ledger.find(p => p.period === to)
      if (!a || !b) throw new Error(`周期需同时存在: ${from} ${to}`)
      const diff = {
        from, to,
        frozenSigned: {
          period: from,
          expenseTotal: a.expenseTotal,
          allocated: a.allocated,
          held: a.held,
          carrierSigned: a.carrierSigned,
        },
        // 本期只列送达凭据产生的调整：付款、抵消、复议差额、暂挂；原期签数不重开
        currentPeriodAdjustments: {
          period: to,
          newServiceExpenseTotal: b.expenseTotal,
          advance: b.claimAdvance,
          payable: b.claimPayable,
          offset: b.claimOffset,
          reviewDelta: b.claimReview,
          held: b.claimHeld,
        },
        receivedClaims: b.claims.map(c => ({
          claim: c.claim, expense: c.expense, treatment: c.treatment,
          advance: c.advance, payable: c.payable, offset: c.offset,
          reviewDelta: c.reviewDelta, held: c.held, note: c.note,
        })),
      }
      if (args.json) printJson(diff)
      else {
        header(`跨期差异 ${from} → ${to}（原期签数冻结，仅列送达期调整）`)
        printJson(diff)
      }
      break
    }
    case 'report':
      if (args.json) printJson(result)
      else {
        for (const t of result.tickets) renderTicket(t)
        header('保障开支分账')
        for (const a of result.allocations) renderAllocation(a)
        renderLedger(result.ledger)
        header('全局冲突/缺口证据')
        printJson(result.evidenceConflicts)
        header('汇总')
        printJson(result.totals)
      }
      break
    default:
      process.stdout.write([
        '用法: node bin/cli.js <command> [参数] [--data 目录] [--json]',
        '  ticket <票证号>        查单一行程的时间窗口、反事实归因、改签与冲突证据',
        '  periods [--period P]   各结算周期总额/已归因/共同费用/未结原因与核对',
        '  diff <期A> <期B>       原期签数与本期应补差分别列示',
        '  report                 全量可解释报告（默认文本，--json 输出机读）',
        '',
      ].join('\n'))
  }
}

main().catch(err => {
  process.stderr.write(`错误: ${err.message}\n`)
  process.exitCode = 1
})
