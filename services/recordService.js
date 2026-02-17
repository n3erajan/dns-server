import { getRecordsCollection } from '../config/mongo.js'
import { parsePTRQuery } from '../utils/dnsHelper.js'

/**
 * Finds a DNS record from the database by name and type
 * @param {Object} params
 * @param {string} params.name - Domain name or PTR query string (e.g., "example.com" or "4.3.2.1.in-addr.arpa")
 * @param {string} params.type - DNS record type (A, AAAA, MX, TXT, PTR, etc.)
 * @returns {Promise<Object|null>} Record object with records array, or null if not found
 */
const findRecord = async ({ name, type }) => {
  const records = getRecordsCollection()
  // PTR queries require reverse lookup: find domain name by IP address
  if (type === 'PTR') {
    // Extract IP address from reverse DNS format (e.g., "4.3.2.1.in-addr.arpa" → "1.2.3.4")
    const ipAddress = parsePTRQuery(name)
    if (!ipAddress) return null
    // Find the domain that has an A record pointing to this IP
    const result = await records.findOne(
      {
        'records.type': 'A',
        'records.content': ipAddress,
      },
      {
        projection: {
          name: 1,
          _id: 0,
        },
      },
    )
    if (!result) return null
    // Return the domain name as the PTR record content
    return {
      records: {
        content: [result.name],
      },
    }
  }

  // Standard lookup: find record by domain name and type
  const result = await records.findOne(
    {
      name: name,
      'records.type': type,
    },
    {
      // Only return the matching record type from the records array
      projection: {
        records: {
          $elemMatch: { type },
        },
        _id: 0,
      },
    },
  )

  if (!result || !result?.records?.length) return null
  return { records: result.records[0] }
}
export { findRecord }
