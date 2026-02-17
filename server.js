import './config/env.js'
import dgram from 'node:dgram'
import { handleQuery } from './handlers/queryHandler.js'
import { handleUpstreamResponse } from './handlers/upstreamHandler.js'
import { connectDatabase } from './config/mongo.js'
import { connectRedis } from './config/redis.js'
import { loadBlockList } from './services/blocklistService.js'
import { styleText } from 'node:util'
import { createIndexes } from './config/indexes.js'
import { startDashboard } from './dashboard/app.js'

await connectDatabase()
await connectRedis()
await loadBlockList()
await createIndexes()
await startDashboard()

// Map to store client info so we can route the upstream response back to them
const pendingRequests = new Map()
// Main DNS server socket to receive queries from clients
const server = dgram.createSocket('udp4')
// Upstream socket to forward queries to external DNS servers (e.g. Cloudflare)
const upstream = dgram.createSocket('udp4')
const PORT = process.env.PORT || 53

server.on('message', async (msg, rinfo) => {
  await handleQuery({ msg, rinfo, server, pendingRequests, upstream })
})

upstream.on('message', async (response) => {
  await handleUpstreamResponse({ response, server, pendingRequests })
})

server.on('error', (err) => {
  console.error(styleText('red', `DNS Server error:\n, ${err}`))
})

server.bind(PORT, '0.0.0.0', () => {
  console.log(styleText('green', `DNS Server running on port ${PORT} `))
})
