/**
 * Plugin metadata helper.
 *
 * Cordis plugins carry `name` / `inject` metadata. tsx/esbuild's `__name`
 * helper marks a class/function's `name` as read-only, so `Object.assign(..,
 * {name})` throws "Cannot assign to read only property 'name'". This helper
 * sets `name` as writable (and attaches `inject`) before returning the plugin,
 * keeping the `Object.assign(plugin, { name, inject })` shape that Cordis
 * expects without the runtime crash.
 */

import type { Inject, Plugin } from 'cordis'

/**
 * Normalize a Cordis `inject` value.
 *
 * Cordis 4 stores `inject` as an object keyed by service name (`{ agent: {} }`);
 * passing a bare `string[]` makes `Object.entries` treat the indices as names,
 * which breaks `ctx.<service>` access ("cannot get property … without inject").
 * We accept both shapes and always emit the object form.
 */
function normalizeInject(inject: Inject): Record<string, unknown> {
  if (Array.isArray(inject)) {
    const out: Record<string, unknown> = {}
    for (const key of inject) out[key] = {}
    return out
  }
  return inject as Record<string, unknown>
}

export function definePlugin<T extends object>(
  target: T,
  name: string,
  inject?: Inject,
): T & Plugin {
  Object.defineProperty(target, 'name', {
    value: name,
    writable: true,
    configurable: true,
  })
  if (inject !== undefined) {
    ;(target as { inject?: Inject }).inject = normalizeInject(inject)
  }
  return target as T & Plugin
}
