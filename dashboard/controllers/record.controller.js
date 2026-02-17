import {
  listRecords,
  createRecord,
  updateRecord,
  deleteRecord,
  getRecordStats,
} from '../services/record.service.js'
import {
  RECORD_TYPES,
  validateType,
  validateName,
} from '../validators/record.validator.js'

/**
 * GET /api/records
 * Lists records as flat rows, optionally filtered by name and type
 */
const list = async (req, res) => {
  const type = req.query.type ? validateType(req.query.type) : undefined
  const [records, stats] = await Promise.all([
    listRecords({ q: req.query.q, type }),
    getRecordStats(),
  ])

  res.json({ records, stats, types: RECORD_TYPES })
}

/**
 * POST /api/records
 * Creates a record for a name and type pair
 */
const create = async (req, res) => {
  const record = await createRecord(req.body ?? {})
  res.status(201).json({ record })
}

/**
 * PATCH /api/records/:name/:type
 * Replaces the content and TTL of an existing record
 */
const update = async (req, res) => {
  const record = await updateRecord({
    name: req.params.name,
    type: req.params.type,
    input: req.body ?? {},
  })
  res.json({ record })
}

/**
 * DELETE /api/records/:name/:type
 * Removes a record, dropping the domain when it was the last one
 */
const remove = async (req, res) => {
  const result = await deleteRecord({
    name: validateName(req.params.name),
    type: validateType(req.params.type),
  })
  res.json(result)
}

export default { list, create, update, remove }
