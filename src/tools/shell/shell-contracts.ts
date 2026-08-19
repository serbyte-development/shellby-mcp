import { z } from "zod"

import { MCP_CONFIG } from "../../config.js"

export const DEFAULT_SHELL_ID = "default"

const requestIdInput = z.string().min(3).max(128).describe("Short operation label, unique within this shell. Reuse only to retry the exact same operation.")

export const shellIdInput = z
  .string()
  .min(3)
  .max(64)
  .default(DEFAULT_SHELL_ID)
  .describe(
    "Unique persistent shell label such as api-audit. Reuse for sequential commands that should share cwd or environment. Use another ID only for concurrent stateful work."
  )

export const closableShellIdInput = z
  .string()
  .min(3)
  .max(64)
  .describe(`Named shell to close. \`${DEFAULT_SHELL_ID}\` shell is protected and cannot be closed; use shell_reset instead.`)

const maxOutputTokensInput = z
  .int()
  .min(1)
  .max(MCP_CONFIG.shell.maxOutputTokens)
  .default(MCP_CONFIG.shell.defaultOutputTokens)
  .describe("Usually omit. Increase only when you need more output in one response; continue retained output with shell_poll.")

export const shellRunInputSchema = z.object({
  shell_id: shellIdInput,
  request_id: requestIdInput.describe(
    "Short command or step label, unique within this shell, such as scan-routes-1. Reuse only to retry the exact same command."
  ),
  cwd: z.string().min(1).optional().describe("Omit to keep the current cwd. Batch commands inherit current cwd."),
  command: z
    .string()
    .min(1)
    .describe(
      "Exact zsh command or multiline script. For a batch, prefix each command with `*** Run:`. Example: `*** Run:\nnpm test\n*** Run: ./api\nnpm run check`."
    ),
  wait_ms: z
    .int()
    .min(0)
    .max(MCP_CONFIG.shell.maxWaitMs)
    .default(MCP_CONFIG.shell.defaultWaitMs)
    .describe("How long to wait before returning. Running commands continue; use shell_poll."),
  max_output_tokens: maxOutputTokensInput,
})

export type ShellRunInput = z.infer<typeof shellRunInputSchema>

export const shellPollInputSchema = z.object({
  shell_id: shellIdInput.describe("The same shell_id used for the original shell_run call."),
  request_id: requestIdInput.describe("The same request_id used for the original shell_run call."),
  cursor: z.int().nonnegative().describe("Pass the next_cursor returned by the previous shell_run or shell_poll."),
  wait_ms: z
    .int()
    .min(0)
    .max(MCP_CONFIG.shell.maxPollWaitMs)
    .default(MCP_CONFIG.shell.defaultPollWaitMs)
    .describe("How long to wait for more output before returning."),
  max_output_tokens: maxOutputTokensInput,
})

export type ShellPollInput = z.infer<typeof shellPollInputSchema>

export const shellResetInputSchema = z.object({
  shell_id: shellIdInput,
  reason: z.string().max(256).optional(),
})

export type ShellResetInput = z.infer<typeof shellResetInputSchema>

export const shellCloseInputSchema = z.object({
  shell_id: closableShellIdInput,
})
