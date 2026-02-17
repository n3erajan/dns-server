import { Router } from 'express'
import recordRouter from './record.routes.js'
import blocklistRouter from './blocklist.routes.js'

const router = Router()

router.use('/records', recordRouter)
router.use('/blocklist', blocklistRouter)

export default router
