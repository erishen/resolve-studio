#!/usr/bin/env node
/**
 * Agent harness entrypoint.
 *
 * Bootstraps a Cordis root context, installs the console logger, then composes
 * the runtime from a `cordis.yml` (use `--config <path>` to override). The
 * composition decides which LLM adapter, which tools, and which frontend (the
 * CLI REPL) are active — exactly the "everything is a plugin" model DeepSeek
 * Harness uses.
 *
 * @module resolve-studio
 */

import 'dotenv/config'
import { Context } from 'cordis'
import { parseArgs } from 'node:util'
import ConsoleExporter from '@cordisjs/plugin-logger-console'
import { loadConfig } from './loader.js'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string', short: 'c' },
  },
  strict: true,
})

const root = new Context()
// Logger time tokens follow cosmokit's Time.template convention (yyyy/MM/dd,
// lowercase hh/mm/ss/SSS) — “HH”/“SS” are not tokens and would print literally.
await root.registry.plugin(ConsoleExporter, { showTime: 'hh:mm:ss' })

const configPath = typeof values.config === 'string' ? values.config : './cordis.yml'
root.logger('boot').info('loading composition from %s', configPath)
await loadConfig(root, configPath)
root.logger('boot').info('composition ready — agent harness is running')

// The active frontend plugin (cli-chat) owns process lifetime via stdin.
