import {
  listBlocked,
  addBlocked,
  removeBlocked,
} from '../services/blocklist.service.js'

/**
 * GET /api/blocklist
 * Lists blocked domains, paginated, with the active in-memory count
 */
const list = async (req, res) => {
  const result = await listBlocked({
    q: req.query.q,
    page: req.query.page,
    limit: req.query.limit,
  })
  res.json(result)
}

/**
 * POST /api/blocklist
 * Adds one or many domains, then reloads the in-memory blocklist
 */
const create = async (req, res) => {
  const body = req.body ?? {}
  const result = await addBlocked(body.domains ?? body.name)
  res.status(201).json(result)
}

/**
 * DELETE /api/blocklist/:name
 * Removes a domain, then reloads the in-memory blocklist
 */
const remove = async (req, res) => {
  const result = await removeBlocked(req.params.name)
  res.json(result)
}

export default { list, create, remove }
