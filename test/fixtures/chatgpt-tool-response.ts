/**
 * MCP result shape captured from a real ChatGPT code-mode turn (2026-09-28).
 * IDs and text are test data; the author, content wrapper, and provenance match the stream.
 */
export function mcpToolResponse(id: string, text: string) {
  return {
    id,
    author: { role: "tool", name: "api_tool.call_tool" },
    content: {
      content_type: "code",
      language: "json",
      response_format_name: null,
      text: JSON.stringify({ text }),
    },
    status: "finished_successfully",
    metadata: {
      working_turn_id: "fixture-turn",
      invoked_resource: { contains_mcp_source: true },
    },
  }
}
