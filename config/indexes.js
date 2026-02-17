import { getRecordsCollection, getBlocklistCollection } from './mongo.js'
import { styleText } from 'node:util'

/**
 * Finds names that appear in more than one records document
 * Used to explain a failed unique index build
 * @returns {Promise<Array<string>>} Duplicated domain names
 */
const findDuplicateNames = async () => {
  const records = getRecordsCollection()
  const groups = await records
    .aggregate([
      { $group: { _id: '$name', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ])
    .toArray()

  return groups.map((group) => group._id)
}

/**
 * Creates the unique index on records.name
 * The dashboard upserts by name, and findRecord() uses findOne, so duplicate
 * documents for one name would silently shadow each other
 */
const createRecordNameIndex = async () => {
  const records = getRecordsCollection()

  try {
    await records.createIndex({ name: 1 }, { unique: true })
  } catch (error) {
    if (error.code !== 11000) throw error

    const duplicates = await findDuplicateNames()
    console.error(
      styleText(
        'yellow',
        `Could not enforce unique domain names: these names have duplicate documents, merge them in the dashboard or MongoDB before records can be edited safely:\n  ${duplicates.join('\n  ')}`,
      ),
    )
  }
}

/**
 * Creates necessary indexes for optimal query performance
 * Should be called once on application startup
 */
const createIndexes = async () => {
  try {
    const records = getRecordsCollection()
    const blocklist = getBlocklistCollection()

    // Index for finding records by name and type (most common query)
    await records.createIndex({ name: 1, 'records.type': 1 })

    // Index for PTR queries (reverse lookup by IP)
    await records.createIndex({ 'records.type': 1, 'records.content': 1 })

    // Index for blocklist lookups (unique domain names)
    await blocklist.createIndex({ name: 1 }, { unique: true })

    // One document per domain, required by the dashboard's upsert by name
    await createRecordNameIndex()

    console.log(styleText('green', 'Database indexes created successfully'))
  } catch (error) {
    // Code 85 = IndexOptionsConflict
    if (error.code !== 85) {
      console.error('Error creating indexes:', error)
    }
  }
}

export { createIndexes }
