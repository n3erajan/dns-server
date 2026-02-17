import net from 'node:net'
import { ValidationError } from '../errors.js'

// PTR is excluded: findRecord() derives PTR from A records, so a manually
// added PTR document would never be read
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT']

const MAX_TTL = 604800 // 7 days
const MAX_NAME_LENGTH = 253
const MAX_LABEL_LENGTH = 63
const MAX_TXT_LENGTH = 4096
const MAX_MX_PREFERENCE = 65535

// Underscores are allowed for mail records (_dmarc, _domainkey)
const LABEL_PATTERN = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/

/**
 * Normalizes a domain name for storage
 * findRecord() matches stored names exactly against query names, which arrive
 * lowercased and without a trailing dot, so every write goes through this
 * @param {string} name - Raw domain name from user input
 * @returns {string} Lowercased name without whitespace or trailing dot
 */
const normalizeName = (name) => {
  if (typeof name !== 'string') return ''
  return name.trim().toLowerCase().replace(/\.$/, '')
}

/**
 * Checks that a normalized name is a structurally valid domain name
 * @param {string} name - Already normalized domain name
 * @returns {boolean} True if every label is well formed
 */
const isValidHostname = (name) => {
  if (!name || name.length > MAX_NAME_LENGTH) return false
  const labels = name.split('.')
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= MAX_LABEL_LENGTH &&
      LABEL_PATTERN.test(label),
  )
}

/**
 * Removes an IPv6 zone index ("fe80::1%10" → "fe80::1")
 * Zone indexes are host local and can't be encoded into a DNS answer
 * @param {string} address - IPv6 address, possibly with a zone index
 * @returns {string} Address without the zone index
 */
const stripZoneIndex = (address) => address.replace(/%.*$/, '')

/**
 * Validates and normalizes a domain name
 * @param {string} name - Raw domain name
 * @param {string} [field] - Field name reported on failure
 * @returns {string} Normalized name
 * @throws {ValidationError} If empty, wildcarded, or malformed
 */
const validateName = (name, field = 'name') => {
  const normalized = normalizeName(name)

  if (!normalized) {
    throw new ValidationError('Name is required', field)
  }

  // Wildcards would never match, findRecord() looks up names exactly
  if (normalized.includes('*')) {
    throw new ValidationError(
      'Wildcard names are not supported, records are matched exactly',
      field,
    )
  }

  if (!isValidHostname(normalized)) {
    throw new ValidationError(
      `"${normalized}" is not a valid domain name`,
      field,
    )
  }

  return normalized
}

/**
 * Validates a record type against the supported set
 * @param {string} type - Record type, any casing
 * @returns {string} Uppercased type
 * @throws {ValidationError} If unsupported
 */
const validateType = (type) => {
  const normalized = String(type ?? '')
    .trim()
    .toUpperCase()

  if (!normalized) {
    throw new ValidationError('Type is required', 'type')
  }

  if (normalized === 'PTR') {
    throw new ValidationError(
      'PTR records are generated automatically from A records',
      'type',
    )
  }

  if (!RECORD_TYPES.includes(normalized)) {
    throw new ValidationError(
      `Unsupported type "${normalized}", expected one of ${RECORD_TYPES.join(', ')}`,
      'type',
    )
  }

  return normalized
}

/**
 * Splits raw textarea input into individual content values
 * TXT splits on newlines only since commas are valid inside SPF values
 * @param {string|Array} content - Raw content from the form or API body
 * @param {string} type - Validated record type
 * @returns {Array} Trimmed, non-empty values
 */
const splitContent = (content, type) => {
  if (Array.isArray(content)) {
    return content.filter((value) => {
      if (typeof value === 'string') return value.trim().length > 0
      return value !== null && value !== undefined
    })
  }

  if (typeof content !== 'string') return []

  const separator = type === 'TXT' ? /[\r\n]+/ : /[\r\n,]+/
  return content
    .split(separator)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

/**
 * Parses a single MX value
 * Accepts the object form and the "10 mail.example.com" form shown in the table
 * @param {Object|string} value - MX value in either form
 * @returns {{preference: number, exchange: string}} Parsed MX value
 * @throws {ValidationError} If preference or exchange is invalid
 */
const parseMxValue = (value) => {
  let preference = value?.preference
  let exchange = value?.exchange

  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+)\s+(\S+)$/)
    if (!match) {
      throw new ValidationError(
        `"${value}" is not a valid MX value, expected "10 mail.example.com"`,
        'content',
      )
    }
    preference = match[1]
    exchange = match[2]
  }

  // Number('') is 0, so a blank priority has to be rejected before parsing
  if (preference === '' || preference === null || preference === undefined) {
    throw new ValidationError('MX priority is required', 'content')
  }

  const parsedPreference = Number(preference)
  if (
    !Number.isInteger(parsedPreference) ||
    parsedPreference < 0 ||
    parsedPreference > MAX_MX_PREFERENCE
  ) {
    throw new ValidationError(
      `MX preference must be a whole number between 0 and ${MAX_MX_PREFERENCE}`,
      'content',
    )
  }

  return {
    preference: parsedPreference,
    exchange: validateName(exchange, 'content'),
  }
}

/**
 * Validates and normalizes record content for a given type
 * @param {string} type - Validated record type
 * @param {string|Array} rawContent - Content from the form or API body
 * @returns {Array} Normalized, de-duplicated values ready for MongoDB
 * @throws {ValidationError} If any value is invalid for the type
 */
const validateContent = (type, rawContent) => {
  const values = splitContent(rawContent, type)

  if (values.length === 0) {
    throw new ValidationError('At least one value is required', 'content')
  }

  if (type === 'CNAME' && values.length > 1) {
    throw new ValidationError(
      'A CNAME record can only point at a single name',
      'content',
    )
  }

  let normalized

  switch (type) {
    case 'A':
      normalized = values.map((value) => {
        if (!net.isIPv4(value)) {
          throw new ValidationError(
            `"${value}" is not a valid IPv4 address`,
            'content',
          )
        }
        return value
      })
      break

    case 'AAAA':
      normalized = values.map((value) => {
        const address = stripZoneIndex(value)
        if (!net.isIPv6(address)) {
          throw new ValidationError(
            `"${value}" is not a valid IPv6 address`,
            'content',
          )
        }
        return address
      })
      break

    case 'CNAME':
      normalized = [validateName(values[0], 'content')]
      break

    case 'MX':
      normalized = values.map(parseMxValue)
      break

    case 'TXT':
      normalized = values.map((value) => {
        const text = String(value)
        if (text.length > MAX_TXT_LENGTH) {
          throw new ValidationError(
            `TXT values must be ${MAX_TXT_LENGTH} characters or fewer`,
            'content',
          )
        }
        return text
      })
      break

    default:
      throw new ValidationError(`Unsupported type "${type}"`, 'type')
  }

  // Drop duplicates so the same answer isn't sent twice in one response
  const seen = new Set()
  return normalized.filter((value) => {
    const key = typeof value === 'object' ? JSON.stringify(value) : value
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Validates an optional TTL
 * Blank means Auto: the field is omitted and buildAnswers() falls back to 50
 * @param {number|string|null|undefined} ttl - Raw TTL input
 * @returns {number|null} TTL in seconds, or null for Auto
 * @throws {ValidationError} If present but not a whole number in range
 */
const validateTtl = (ttl) => {
  if (ttl === null || ttl === undefined || ttl === '') return null

  const parsed = Number(ttl)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_TTL) {
    throw new ValidationError(
      `TTL must be a whole number between 0 and ${MAX_TTL} seconds, or blank for Auto`,
      'ttl',
    )
  }

  return parsed
}

/**
 * Validates a complete record payload
 * @param {Object} input
 * @param {string} input.name - Domain name
 * @param {string} input.type - Record type
 * @param {string|Array} input.content - Record content
 * @param {number|string|null} [input.ttl] - Optional TTL in seconds
 * @returns {{name: string, type: string, content: Array, ttl: number|null}} Normalized record
 * @throws {ValidationError} On the first invalid field
 */
const validateRecordInput = ({ name, type, content, ttl }) => {
  const validatedType = validateType(type)
  return {
    name: validateName(name),
    type: validatedType,
    content: validateContent(validatedType, content),
    ttl: validateTtl(ttl),
  }
}

export {
  RECORD_TYPES,
  MAX_TTL,
  normalizeName,
  isValidHostname,
  stripZoneIndex,
  validateName,
  validateType,
  validateContent,
  validateTtl,
  validateRecordInput,
}
