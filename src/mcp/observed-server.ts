import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  McpServer,
  type Transport,
} from "@modelcontextprotocol/server"
import { ToolCallTracker } from "./tool-call-tracker.js"

/** Observe SDK responses after validation and projection, without interpreting tool schemas. */
export class ObservedMcpServer extends McpServer {
  constructor(
    info: ConstructorParameters<typeof McpServer>[0],
    options?: ConstructorParameters<typeof McpServer>[1],
    readonly calls = new ToolCallTracker()
  ) {
    super(info, options)
  }

  override connect(transport: Transport): Promise<void> {
    // connect takes ownership of this transport. Observe its final messages rather than
    // duplicating SDK validation or depending on private request-handler internals.
    const send = transport.send.bind(transport)
    transport.send = (message, options) => {
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        this.calls.respond(message)
      }
      return send(message, options)
    }
    return super.connect(transport)
  }
}
