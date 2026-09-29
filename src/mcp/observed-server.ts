import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type JSONRPCResponse,
  McpServer,
  type RequestId,
  type ServerContext,
  type Transport,
} from "@modelcontextprotocol/server"

/** Observe SDK responses after validation and projection, without interpreting tool schemas. */
export class ObservedMcpServer extends McpServer {
  private readonly pending = new Map<RequestId, (response?: JSONRPCResponse) => void>()

  /**
   * Register once per dispatched tool call. The listener runs once at transport handoff,
   * or with undefined if the request ends without a response. This does not prove peer receipt.
   * Listener failures are reported without preventing the SDK from sending its response.
   */
  observeToolResponse(
    context: ServerContext,
    listener: (response?: JSONRPCResponse) => void
  ): void {
    const { id, signal } = context.mcpReq
    const finish = (response?: JSONRPCResponse) => {
      this.pending.delete(id)
      signal.removeEventListener("abort", abort)
      try {
        listener(response)
      } catch (error) {
        console.warn("Could not record MCP tool response:", error)
      }
    }
    const abort = () => finish()
    this.pending.set(id, finish)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  }

  override connect(transport: Transport): Promise<void> {
    // connect takes ownership of this transport. Observe its final messages rather than
    // duplicating SDK validation or depending on private request-handler internals.
    const send = transport.send.bind(transport)
    transport.send = (message, options) => {
      if (
        (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
        message.id !== undefined
      ) {
        this.pending.get(message.id)?.(message)
      }
      return send(message, options)
    }
    return super.connect(transport)
  }
}
