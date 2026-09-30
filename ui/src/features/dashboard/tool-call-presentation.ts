import {
  IconBook,
  IconDeviceDesktop,
  IconFilePencil,
  IconFileText,
  IconMessageStar,
  IconPhoto,
  IconRobot,
  IconTerminal2,
  IconTool,
  IconWorld,
} from "@react-zero-ui/icon-sprite"

import type { AgentCall } from "../../types.js"

const tools: Record<string, [typeof IconTool, string]> = {
  shell_run: [IconTerminal2, "Running commands"],
  shell_poll: [IconTerminal2, "Checking command output"],
  shell_list: [IconTerminal2, "Listing shells"],
  shell_reset: [IconTerminal2, "Resetting shell"],
  shell_close: [IconTerminal2, "Closing shell"],
  apply_patch: [IconFilePencil, "Applying patch"],
  file_read: [IconFileText, "Reading file"],
  file_write: [IconFilePencil, "Writing file"],
  image_view: [IconPhoto, "Viewing image"],
  fetch_url: [IconWorld, "Fetching website"],
  subagent_run: [IconRobot, "Running subagents"],
  subagent_result: [IconRobot, "Checking subagent results"],
  skill_list: [IconBook, "Listing skills"],
  skill_use: [IconBook, "Loading skill"],
  start_here: [IconBook, "Loading workspace instructions"],
  submit_review: [IconMessageStar, "Submitting review"],
  computer_list: [IconDeviceDesktop, "Listing apps and windows"],
  computer_observe: [IconDeviceDesktop, "Viewing screen"],
  computer_inspect: [IconDeviceDesktop, "Inspecting screen"],
  computer_click: [IconDeviceDesktop, "Clicking"],
  computer_type: [IconDeviceDesktop, "Typing text"],
  computer_press: [IconDeviceDesktop, "Pressing keys"],
  computer_hotkey: [IconDeviceDesktop, "Using keyboard shortcut"],
  computer_scroll: [IconDeviceDesktop, "Scrolling"],
  computer_drag: [IconDeviceDesktop, "Dragging"],
  computer_app: [IconDeviceDesktop, "Controlling app"],
  computer_window: [IconDeviceDesktop, "Controlling window"],
}

/** Display hints only. Unrecognized input stays generic; full captured input lives in the modal. */
export function describeToolCall(call: Pick<AgentCall, "tool" | "detail" | "summary">) {
  const presentation = Object.hasOwn(tools, call.tool) ? tools[call.tool] : undefined
  const [icon, defaultSummary] = presentation ?? [IconTool, call.summary || "Using tool"]
  const input = call.detail ?? call.summary
  let summary = defaultSummary
  if (call.tool === "shell_run") summary = describeShell(input)
  if (call.tool === "apply_patch") {
    const files = [...input.matchAll(/^\*\*\* (Update|Add|Delete) File:/gmu)]
    if (files.length > 1) summary = "Editing files"
    else if (files[0]?.[1] === "Update") summary = "Updating file"
    else if (files[0]?.[1] === "Add") summary = "Creating file"
    else if (files[0]?.[1] === "Delete") summary = "Deleting file"
  }
  return { icon, summary }
}

function describeShell(input: string): string {
  const command = input.trim().replace(/\b[12]>&[12]\b/gu, "")
  // Compound commands and scripts need a real shell parser; keep their label deliberately broad.
  if (/[;&\n`]|\$\(|\s-(?:exec|execdir|ok|okdir|delete)\b/u.test(command)) return "Running commands"
  if (
    /^(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|tee)\b/u.test(command) ||
    /^(?:sed|perl)\s+.*-\w*i\b/u.test(command) ||
    />/u.test(command)
  ) {
    return "Editing files"
  }
  if (
    command
      .split("|")
      .every((part) =>
        /^\s*(?:cat|head|tail|less|more|rg|grep|sed|find|ls|pwd|wc|stat|file|du|tree|readlink)\b/u.test(
          part
        )
      )
  ) {
    return "Reading files"
  }
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/u.test(command)) return "Running tests"
  return "Running commands"
}
