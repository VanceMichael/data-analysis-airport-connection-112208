// 读取合成资料。来源文件只读，工具不回写任何输入。
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const TABLE_NAMES = [
  'trips',
  'legs',
  'counterfactual',
  'rebooks',
  'expenses',
  'agreements',
  'rooms',
  'rebook_updates',
  'accounting',
]

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')

/**
 * @param {string} [dataDir] 资料目录，默认项目内 data/
 * @returns {Promise<Record<string, Array<Record<string,string>>>>}
 */
export async function loadTables(dataDir = DEFAULT_DIR) {
  const tables = {}
  for (const name of TABLE_NAMES) {
    const file = path.resolve(dataDir, `${name}.json`)
    const raw = await readFile(file, 'utf8')
    tables[name] = JSON.parse(raw)
  }
  return tables
}

/** 按字段建索引：同一键值可能对应多条记录。 */
export function groupBy(rows, key) {
  const map = new Map()
  for (const row of rows) {
    const k = row[key]
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(row)
  }
  return map
}

export function indexBy(rows, key) {
  const map = new Map()
  for (const row of rows) map.set(row[key], row)
  return map
}
