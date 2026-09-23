/** Public tool failure information. Causes stay in diagnostics, outside the MCP response. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "ToolError"
  }
}
