// pino-roll 4 ships JavaScript only. Keep its used contract typed at the integration boundary.
declare module "pino-roll" {
  import type pino from "pino"
  export default function pinoRoll(options: {
    file: string
    size: string
    limit: { count: number; removeOtherLogFiles: boolean }
    symlink: boolean
    mode: number
    maxLength: number
  }): Promise<ReturnType<typeof pino.destination>>
}
