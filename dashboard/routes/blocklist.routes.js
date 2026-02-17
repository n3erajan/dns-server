import { Router } from 'express'
import blocklistController from '../controllers/blocklist.controller.js'

const blocklistRouter = Router()

blocklistRouter.get('/', blocklistController.list)
blocklistRouter.post('/', blocklistController.create)
blocklistRouter.delete('/:name', blocklistController.remove)

export default blocklistRouter
