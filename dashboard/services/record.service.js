import { getRecordsCollection } from '../../config/mongo.js'
import { ConflictError, NotFoundError } from '../errors.js'
import { validateRecordInput } from '../validators/record.validator.js'

/**
 * Escapes user input for safe use inside a RegExp
 * @param {string} value - Raw search text
 * @returns {string} Value with regex metacharacters escaped
 */
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Builds the MongoDB element for a records[] entry
 * ttl is omitted entirely when Auto so buildAnswers() falls back to its default
 * @param {Object} record - Validated record
 * @returns {Object} records[] element
 */
const toElement = ({ type, content, ttl }) => {
  const element = { type, content }
  if (ttl !== null) element.ttl = ttl
  return element
}

/**
 * Lists records as one flat row per name and type pair
 * @param {Object} [params]
 * @param {string} [params.q] - Case insensitive name filter
 * @param {string} [params.type] - Exact record type filter
 * @returns {Promise<Array>} Rows of { name, type, content, ttl }
 */
const listRecords = async ({ q, type } = {}) => {
  const records = getRecordsCollection()
  const filter = {}

  if (q) filter.name = { $regex: escapeRegex(q.trim()), $options: 'i' }
  if (type) filter['records.type'] = type

  const docs = await records.find(filter).sort({ name: 1 }).toArray()

  const rows = []
  for (const doc of docs) {
    for (const element of doc.records ?? []) {
      // A document matches if any of its types match, so filter again per row
      if (type && element.type !== type) continue
      rows.push({
        name: doc.name,
        type: element.type,
        content: element.content ?? [],
        ttl: element.ttl ?? null,
      })
    }
  }

  // Group a domain's types together, A first
  return rows.sort(
    (a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type),
  )
}

/**
 * Finds a single row by name and type
 * @param {Object} params
 * @param {string} params.name - Normalized domain name
 * @param {string} params.type - Record type
 * @returns {Promise<Object|null>} Row of { name, type, content, ttl }, or null
 */
const getRecord = async ({ name, type }) => {
  const records = getRecordsCollection()
  const doc = await records.findOne(
    { name, 'records.type': type },
    { projection: { records: { $elemMatch: { type } }, name: 1, _id: 0 } },
  )

  if (!doc?.records?.length) return null

  const element = doc.records[0]
  return {
    name: doc.name,
    type: element.type,
    content: element.content ?? [],
    ttl: element.ttl ?? null,
  }
}

/**
 * Creates a record, pushing onto the existing document for that name
 * @param {Object} input - Raw record payload from the API
 * @returns {Promise<Object>} The created row
 * @throws {ValidationError} If the payload is invalid
 * @throws {ConflictError} If that name already has a record of this type
 */
const createRecord = async (input) => {
  const record = validateRecordInput(input)
  const records = getRecordsCollection()

  const existing = await records.findOne({
    name: record.name,
    'records.type': record.type,
  })

  if (existing) {
    throw new ConflictError(
      `${record.name} already has a ${record.type} record, edit it instead`,
      'name',
    )
  }

  // CNAME can't coexist with other types at the same name (RFC 1034)
  if (record.type === 'CNAME') {
    const hasOtherTypes = await records.findOne({
      name: record.name,
      'records.0': { $exists: true },
    })
    if (hasOtherTypes) {
      throw new ConflictError(
        `${record.name} already has other records, a CNAME cannot coexist with them`,
        'type',
      )
    }
  } else {
    const hasCname = await records.findOne({
      name: record.name,
      'records.type': 'CNAME',
    })
    if (hasCname) {
      throw new ConflictError(
        `${record.name} has a CNAME record, no other types can be added to it`,
        'type',
      )
    }
  }

  await records.updateOne(
    { name: record.name },
    { $push: { records: toElement(record) } },
    { upsert: true },
  )

  return record
}

/**
 * Replaces the content and TTL of an existing record
 * @param {Object} params
 * @param {string} params.name - Domain name from the URL
 * @param {string} params.type - Record type from the URL
 * @param {Object} params.input - Body containing content and optional ttl
 * @returns {Promise<Object>} The updated row
 * @throws {ValidationError} If the payload is invalid
 * @throws {NotFoundError} If no such record exists
 */
const updateRecord = async ({ name, type, input }) => {
  const record = validateRecordInput({ ...input, name, type })
  const records = getRecordsCollection()

  // $set and $unset target different paths, so both can be applied at once
  const update =
    record.ttl === null
      ? {
          $set: { 'records.$.content': record.content },
          $unset: { 'records.$.ttl': '' },
        }
      : {
          $set: {
            'records.$.content': record.content,
            'records.$.ttl': record.ttl,
          },
        }

  const result = await records.updateOne(
    { name: record.name, 'records.type': record.type },
    update,
  )

  if (result.matchedCount === 0) {
    throw new NotFoundError(`No ${record.type} record found for ${record.name}`)
  }

  return record
}

/**
 * Deletes a record, removing the document when it was the last one
 * @param {Object} params
 * @param {string} params.name - Normalized domain name
 * @param {string} params.type - Record type
 * @returns {Promise<{name: string, type: string, domainRemoved: boolean}>} Delete result
 * @throws {NotFoundError} If no such record exists
 */
const deleteRecord = async ({ name, type }) => {
  const records = getRecordsCollection()

  const result = await records.updateOne(
    { name, 'records.type': type },
    { $pull: { records: { type } } },
  )

  if (result.matchedCount === 0) {
    throw new NotFoundError(`No ${type} record found for ${name}`)
  }

  // Don't leave an empty document behind
  const cleanup = await records.deleteOne({
    name,
    $or: [{ records: { $size: 0 } }, { records: { $exists: false } }],
  })

  return { name, type, domainRemoved: cleanup.deletedCount > 0 }
}

/**
 * Counts records and distinct domains for the dashboard header
 * @returns {Promise<{domains: number, records: number}>} Totals
 */
const getRecordStats = async () => {
  const records = getRecordsCollection()
  const docs = await records
    .find({}, { projection: { records: 1, _id: 0 } })
    .toArray()

  return {
    domains: docs.length,
    records: docs.reduce((total, doc) => total + (doc.records?.length ?? 0), 0),
  }
}

export {
  listRecords,
  getRecord,
  createRecord,
  updateRecord,
  deleteRecord,
  getRecordStats,
}
