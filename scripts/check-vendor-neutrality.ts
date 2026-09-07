/**
 * The core must not name a vendor.
 *
 * This is a commercial constraint, not a matter of taste: the core is sold as
 * an open product and the adapters that talk to particular shops, marketplaces
 * and carriers are sold, or given away, separately. A vendor's name in the core
 * means the code was written against that vendor rather than against the port,
 * and the next integration then has to be written twice.
 *
 * A comment counts as much as an import. "PrestaShop stores it as -1 here" in a
 * comment is a sign the function knows which shop it is reading.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const GUARDED = join(ROOT, 'src')

/** Names, and the schema details that give a vendor away without naming it. */
const FORBIDDEN: readonly string[] = [
  'prestashop',
  'medusa',
  'rozetka',
  'prom.ua',
  'salesdrive',
  'novaposhta',
  'nova poshta',
  'monobank',
  'monopay',
  'checkbox.in.ua',
  'specific_price',
  'curls_',
  'ps_product',
]

interface Violation {
  file: string
  line: number
  word: string
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return walk(path)
    return extname(path) === '.ts' ? [path] : []
  })
}

const violations: Violation[] = []
for (const file of walk(GUARDED)) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    // The same escape hatch the channel boundary check uses, for the rare line
    // that has to name something to explain why it must not be named.
    if (line.includes('boundary-allow')) return
    const lowered = line.toLowerCase()
    for (const word of FORBIDDEN) {
      if (lowered.includes(word)) {
        violations.push({ file: relative(ROOT, file), line: index + 1, word })
      }
    }
  })
}

if (violations.length > 0) {
  console.error('The core names a vendor:\n')
  for (const violation of violations) {
    console.error(`  ${violation.file}:${String(violation.line)} mentions "${violation.word}"`)
  }
  console.error('\nA vendor belongs behind a port, in a package of its own.')
  process.exit(1)
}

process.stdout.write(`Vendor neutrality check passed (src, ${String(FORBIDDEN.length)} terms).\n`)
