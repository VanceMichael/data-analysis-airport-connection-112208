// 通用值处理：来源资料的数字、日期、标记均以字符串保存；问号表示来源未提供。

export const MISSING = '?'

/** 解析为整数；未提供（问号/空值）返回 null。 */
export function num(value) {
  if (value === undefined || value === null || value === MISSING || value === '') return null
  return Number.parseInt(value, 10)
}

/** 加号分隔的组合编号（如 "A1+A2"）。 */
export function splitList(value) {
  if (value === undefined || value === null || value === MISSING || value === '') return []
  return value.split('+').map(s => s.trim()).filter(Boolean)
}

/** 金额/份额按两位小数四舍五入（避免分摊出现长尾小数，尾差单列保留）。 */
export function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/** 四舍五入并保留为数字；用于输出。 */
export function money(value) {
  return round2(value)
}

/** 分钟数转 HH:MM，仅用于报告展示；null 原样返回。 */
export function clock(minutes) {
  if (minutes === null || minutes === undefined) return MISSING
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
