import net from 'node:net'
import { getBlocklistCollection } from '../../config/mongo.js'
import { loadBlockList, getBlockedCount } from '../../services/blocklistService.js'
import { NotFoundError, ValidationError } from '../errors.js'
import { normalizeName, isValidHostname } from '../validators/record.validator.js'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500
const MAX_BULK_DOMAINS = 10000

/**
 * Escapes user input for safe use inside a RegExp
 * @param {string} value - Raw search text
 * @returns {string} Value with regex metacharacters escaped
 */
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Lists blocked domains, paginated
 * @param {Object} [params]
 * @param {string} [params.q] - Case insensitive name filter
 * @param {number} [params.page] - 1 based page number
 * @param {number} [params.limit] - Page size
 * @returns {Promise<Object>} Page of domains plus totals and active in-memory count
 */
const listBlocked = async ({ q, page = 1, limit = DEFAULT_PAGE_SIZE } = {}) => {
  const blocklist = getBlocklistCollection()

  const pageNumber = Math.max(1, Number(page) || 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || DEFAULT_PAGE_SIZE))

  const filter = q ? { name: { $regex: escapeRegex(q.trim()), $options: 'i' } } : {}

  const [docs, total] = await Promise.all([
    blocklist
      .find(filter, { projection: { name: 1, _id: 0 } })
      .sort({ name: 1 })
      .skip((pageNumber - 1) * pageSize)
      .limit(pageSize)
      .toArray(),
    blocklist.countDocuments(filter),
  ])

  return {
    domains: docs.map((doc) => doc.name),
    total,
    page: pageNumber,
    limit: pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    active: getBlockedCount(),
  }
}

/**
 * Parses pasted input into domain names
 * Accepts newline and comma separated lists, plus hosts file lines where an IP
 * prefix is stripped ("0.0.0.0 ads.example.com")
 * @param {string|Array} input - Raw domains from the textarea or API body
 * @returns {Array<string>} Candidate domain names
 */
const parseDomainList = (input) => {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/[\r\n,]+/)

  const candidates = []
  for (const rawLine of lines) {
    const line = String(rawLine).split('#')[0].trim() // drop hosts file comments
    if (!line) continue

    const parts = line.split(/\s+/)
    // Hosts file line, an IP followed by one or more names
    if (parts.length > 1 && net.isIP(parts[0])) {
      candidates.push(...parts.slice(1))
      continue
    }

    // Anything else is reported in full when it fails validation
    candidates.push(line)
  }

  return candidates
}

/**
 * Adds domains to the blocklist and reloads the in-memory set
 * Invalid entries are skipped and reported rather than failing the whole paste
 * @param {string|Array} input - Raw domains from the textarea or API body
 * @returns {Promise<Object>} Counts of added, duplicate and invalid entries
 * @throws {ValidationError} If nothing usable was submitted
 */
const addBlocked = async (input) => {
  const candidates = parseDomainList(input)

  if (candidates.length === 0) {
    throw new ValidationError('At least one domain is required', 'domains')
  }

  if (candidates.length > MAX_BULK_DOMAINS) {
    throw new ValidationError(
      `Too many domains at once, the limit is ${MAX_BULK_DOMAINS} per request`,
      'domains',
    )
  }

  const valid = new Set()
  const invalid = []

  for (const candidate of candidates) {
    const name = normalizeName(candidate)
    if (name && !name.includes('*') && isValidHostname(name)) {
      valid.add(name)
    } else {
      invalid.push(candidate)
    }
  }

  if (valid.size === 0) {
    throw new ValidationError(
      `No valid domains found in ${candidates.length} ${candidates.length === 1 ? 'entry' : 'entries'}`,
      'domains',
    )
  }

  const blocklist = getBlocklistCollection()
  const result = await blocklist.bulkWrite(
    [...valid].map((name) => ({
      updateOne: { filter: { name }, update: { $setOnInsert: { name } }, upsert: true },
    })),
    { ordered: false },
  )

  const added = result.upsertedCount ?? 0

  // Refresh the set the DNS query path reads, so no restart is needed
  const active = await loadBlockList()

  return {
    added,
    duplicates: valid.size - added,
    invalid,
    active,
  }
}

/**
 * Removes a domain from the blocklist and reloads the in-memory set
 * @param {string} domain - Domain name to unblock
 * @returns {Promise<{name: string, active: number}>} Removed name and new active count
 * @throws {NotFoundError} If the domain isn't blocked
 */
const removeBlocked = async (domain) => {
  const name = normalizeName(domain)
  const blocklist = getBlocklistCollection()

  const result = await blocklist.deleteOne({ name })

  if (result.deletedCount === 0) {
    throw new NotFoundError(`${name || domain} is not in the blocklist`)
  }

  const active = await loadBlockList()
  return { name, active }
}

export { listBlocked, addBlocked, removeBlocked }
