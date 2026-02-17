/**
 * HTTP error types for the dashboard API
 * The error middleware in app.js maps these to responses
 * Anything that isn't an HttpError becomes a 500
 */
class HttpError extends Error {
  constructor(status, message, field) {
    super(message)
    this.name = this.constructor.name
    this.status = status
    if (field) this.field = field
  }
}

// 400: carries the field name so the UI can show the message inline
class ValidationError extends HttpError {
  constructor(message, field) {
    super(400, message, field)
  }
}

// 404: record or blocked domain does not exist
class NotFoundError extends HttpError {
  constructor(message) {
    super(404, message)
  }
}

// 409: record already exists and would be silently overwritten
class ConflictError extends HttpError {
  constructor(message, field) {
    super(409, message, field)
  }
}

// 503: MongoDB unreachable
class UnavailableError extends HttpError {
  constructor(message) {
    super(503, message)
  }
}

export {
  HttpError,
  ValidationError,
  NotFoundError,
  ConflictError,
  UnavailableError,
}
