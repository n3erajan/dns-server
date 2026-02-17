import { getBlocklistCollection } from '../config/mongo.js'
import { styleText } from 'node:util'

// In-memory set for fast O(1) domain blocking lookups
const blockedDomains = new Set()

/**
 * Loads blocked domains from MongoDB into memory for fast lookup
 * Called on server startup and by the dashboard after every blocklist edit
 * @returns {Promise<number>} Number of domains now loaded
 */
const loadBlockList = async () => {
  const blockedCollection = getBlocklistCollection()

  const docs = await blockedCollection
    .find({}, { projection: { name: 1 } })
    .toArray()
  blockedDomains.clear()
  for (const doc of docs) {
    blockedDomains.add(doc.name)
  }
  console.log(
    styleText('green', `Loaded ${blockedDomains.size} blocked domains`),
  )
  return blockedDomains.size
}

/**
 * Checks if a domain is in the blocklist
 * @param {string} domain - Domain name to check
 * @returns {boolean} True if domain is blocked
 */
const isBlocked = (domain) => {
  return blockedDomains.has(domain)
}

/**
 * Returns how many domains are currently blocked in memory
 * @returns {number} Size of the in-memory blocklist
 */
const getBlockedCount = () => {
  return blockedDomains.size
}

export { loadBlockList, isBlocked, getBlockedCount }
