import { Router } from 'express'
import recordController from '../controllers/record.controller.js'

const recordRouter = Router()

recordRouter.get('/', recordController.list)
recordRouter.post('/', recordController.create)
recordRouter.patch('/:name/:type', recordController.update)
recordRouter.delete('/:name/:type', recordController.remove)

export default recordRouter
