export class WorkspaceSentinelError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'WorkspaceSentinelError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}
