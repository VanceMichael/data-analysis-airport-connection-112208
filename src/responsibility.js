// 按模拟协议对应的协议条款，把归因结果转成各责任方份额。
// K1/K2 条款：single=独立可恢复方均分；combined=必要责任方均分；unresolved=暂挂。

function equalShares(causes) {
  const share = 1 / causes.length
  return Object.fromEntries(causes.map(c => [c, share]))
}

export function buildResponsibility(attribution, agreements) {
  const agreement = agreements.find(a => a.rule === attribution.rule)
  const base = {
    ticket: attribution.ticket,
    rule: attribution.rule,
    status: attribution.status,
    agreement: agreement
      ? agreement[attribution.status === 'single' ? 'single' : 'combined']
      : null,
    shares: {},
    held: false,
    reasons: [],
  }

  switch (attribution.status) {
    case 'connected':
      base.reasons.push('实际证据重建为已接上原航班，无误机责任')
      break
    case 'single':
      base.shares = equalShares(attribution.singleSufficient)
      base.reasons.push(
        `独立可恢复方均分（协议条款：${agreement?.single ?? '?'}）：` +
        `${attribution.singleSufficient.join('、')} 各自单项消除即可接上`,
      )
      break
    case 'combined': {
      // 必要责任方 = 全部最小充分集合的交集；若集合并列且无共同必要方，回退暂挂
      const sets = attribution.minimalSufficientSets
      const intersection = sets[0].filter(c => sets.every(set => set.includes(c)))
      if (intersection.length === 0) {
        base.status = 'unresolved'
        base.held = true
        base.reasons.push('并列最小充分集合无共同必要责任方，证据无法唯一归属，按暂挂处理')
      } else {
        base.shares = equalShares(intersection)
        base.reasons.push(
          `必要责任方均分（协议条款：${agreement?.combined ?? '?'}）：必须同时消除 ` +
          sets.map(s => `[${s.join('+')}]`).join(' 或 ') +
          `，共同必要方为 ${intersection.join('、')}`,
        )
      }
      break
    }
    case 'unresolved':
    default:
      base.status = 'unresolved'
      base.held = true
      base.shares = {}
      base.reasons.push(
        attribution.testableCauses.length === 0
          ? '无适用于本票证规则与航班的反事实证据，责任无法认定，按暂挂处理'
          : '全部消除方案均无法证明可接上原航班（或证据互相矛盾），按暂挂处理',
      )
      break
  }

  return base
}
