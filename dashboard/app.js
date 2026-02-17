import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { styleText } from 'node:util'
import { HttpError } from './errors.js'
import router from './routes/index.js'

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')

// Loopback by default so `npm run dev` never exposes the dashboard to the LAN
// Docker overrides this to 0.0.0.0 and publishes on 127.0.0.1 instead
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8053

/**
 * Maps a thrown error onto an HTTP status and message
 * Only HttpError messages are shown to the user, everything else is a generic 500
 * @param {Error} error - Error thrown by a route handler
 * @returns {{status: number, body: Object}} Response status and JSON body
 */
const toErrorResponse = (error) => {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: { error: error.message, ...(error.field && { field: error.field }) },
    }
  }

  // Unique index violation, most likely two writes racing for the same name
  if (error?.code === 11000) {
    return { status: 409, body: { error: 'That record already exists' } }
  }

  // Mongo is down or was never connected
  if (
    error?.name?.startsWith('Mongo') ||
    error?.message === 'Database not initialized. Call connectDatabase first.'
  ) {
    return {
      status: 503,
      body: { error: 'Database unavailable, check that MongoDB is running' },
    }
  }

  return { status: 500, body: { error: 'Something went wrong' } }
}

/**
 * Builds the dashboard Express app
 * @returns {import('express').Express} Configured app
 */
const createApp = () => {
  const app = express()

  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))
  app.use(express.static(publicDir))
  app.use('/api', router)

  app.use('/api', (req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` })
  })

  // Express 5 forwards async handler rejections here, so a bad request can't
  // take down the DNS server sharing this process
  app.use((error, req, res, next) => {
    const { status, body } = toErrorResponse(error)

    if (status >= 500) {
      console.error(styleText('red', `[Dashboard] ${req.method} ${req.originalUrl}`), error)
    }

    res.status(status).json(body)
  })

  return app
}

/**
 * Starts the dashboard HTTP server
 * Failures are logged and swallowed so the DNS server keeps running even if
 * the port is already taken
 * @returns {Promise<import('node:http').Server|null>} Listening server, or null if it failed
 */
const startDashboard = async () => {
  const port = Number(process.env.DASHBOARD_PORT) || DEFAULT_PORT
  const host = process.env.DASHBOARD_HOST || DEFAULT_HOST

  return new Promise((resolve) => {
    const server = createApp().listen(port, host, () => {
      console.log(styleText('green', `Dashboard running on http://${host}:${port}`))
      resolve(server)
    })

    server.on('error', (error) => {
      const reason =
        error.code === 'EADDRINUSE'
          ? `port ${port} is already in use`
          : error.message
      console.error(
        styleText('red', `Dashboard failed to start (${reason}), DNS server continuing`),
      )
      resolve(null)
    })
  })
}

export { createApp, startDashboard }
