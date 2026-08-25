/**
 * @agent-harness/plugin-hello — a sample first-party Cordis plugin.
 *
 * This package exists to prove the monorepo + loader story end-to-end:
 *   - it lives in `packages/plugin-hello` (its own workspace package),
 *   - it is referenced from `cordis.patch.yml` by its *package name*
 *     (`@agent-harness/plugin-hello`), not a local file path,
 *   - the loader resolves it via dynamic `import()` with no special-casing,
 *   - so the exact same plugin could be published to npm and loaded by any
 *     Cordis-4 runtime (including DeepSeek Harness) without code changes.
 *
 * It follows the pure-Cordis contract: only `cordis` is imported, no dsh-*
 * services. That is what makes it ecosystem-portable.
 */

import { Context, Service } from 'cordis'

declare module 'cordis' {
  interface Context {
    hello: HelloService
  }
}

export interface HelloOptions {
  /** Heartbeat interval in milliseconds. */
  interval?: number
  /** Greeting printed on each heartbeat. */
  greeting?: string
}

export class HelloService extends Service {
  private timer?: NodeJS.Timeout
  private readonly interval: number
  private readonly greeting: string

  constructor(ctx: Context, options: HelloOptions = {}) {
    super(ctx, 'hello')
    this.interval = options.interval ?? 15_000
    this.greeting = options.greeting ?? 'hello from @agent-harness/plugin-hello'
  }

  /** Emit a single greeting line. Callable from other plugins via `ctx.hello.say()`. */
  say(): string {
    this.ctx.logger('hello').info(this.greeting)
    return this.greeting
  }

  protected start() {
    this.ctx.logger('hello').info('hello service started')
    this.timer = setInterval(() => this.say(), this.interval)
  }

  protected stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.ctx.logger('hello').info('hello service stopped')
  }
}

export default (ctx: Context, options: HelloOptions = {}) => {
  ctx.plugin(HelloService, options)
}
