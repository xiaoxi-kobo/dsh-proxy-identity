/**
 * dsh-proxy-identity — attach fixed identity headers to every model request.
 *
 * Some shared model gateways (a memory proxy, a team LLM router, a self-hosted
 * Anthropic-compatible endpoint) identify the caller from request headers they
 * name themselves, and fall back to an interactive picker when those headers are
 * missing. That picker has no answer for a client that cannot render it, so the
 * conversation silently loses whatever the gateway would have attached.
 *
 * This plugin sends the headers from configuration on every request whose URL
 * matches one of the configured fragments. Requests that match nothing are
 * forwarded untouched, header values are never logged, and the wrapper is
 * removed again when the plugin disposes.
 *
 * Warning: the wrapper is installed over `globalThis.fetch`, the call the
 * shipped DeepSeek adapters use to reach their endpoint. It adds the configured
 * headers and changes nothing else — but it is a process-wide patch, not a
 * first-party seam. Install it only for the gateway that needs it.
 */

/** Plugin name the patch row references. */
export const name = 'proxy-identity'

/** Nothing in the harness is a hard dependency: the patch is self-contained. */
export const inject = []

const TAG = '[dsh-proxy-identity]'

/**
 * Process-wide patch state, keyed by a symbol so module reloads (HMR) find the
 * wrapper that is already installed instead of stacking a second one.
 */
const STATE = Symbol.for('dsh.proxy-identity')

/** @returns {{ rules: object[], original: Function | undefined, wrapper: Function | undefined }} */
function stateOf() {
  const found = globalThis[STATE]
  if (found !== undefined) return found
  const created = { rules: [], original: undefined, wrapper: undefined }
  Object.defineProperty(globalThis, STATE, {
    value: created, enumerable: false, configurable: true, writable: false,
  })
  return created
}

/**
 * Mount the plugin. A bundle row mounts without configuration, and a plugin with
 * nothing to send is a no-op rather than an error: the user opts in by editing
 * their profile patch.
 *
 * @param {object} ctx - Cordis context.
 * @param {{ match?: string | (string | RegExp)[], headers?: Record<string, string> }} [config]
 */
export function apply(ctx, config) {
  const rule = readRule(config)
  if (rule === undefined) return
  ctx.effect(() => install(rule))
}

/**
 * Validate one configuration into a rule, or explain once why it cannot send
 * anything.
 *
 * @param {unknown} config
 * @returns {{ matchers: (string | RegExp)[], headers: [string, string][] } | undefined}
 */
function readRule(config) {
  const matchers = readMatchers(config?.match)
  const headers = readHeaders(config?.headers)
  if (matchers.length === 0 || headers.length === 0) {
    console.warn(
      `${TAG} idle: set both \`match\` (URL fragments or patterns) and \`headers\` `
      + 'in the plugin row of your profile cordis.patch.yml. Nothing is injected until then.',
    )
    return undefined
  }
  return { matchers, headers }
}

/** @param {unknown} match */
function readMatchers(match) {
  const list = Array.isArray(match) ? match : [match]
  /** @type {(string | RegExp)[]} */
  const matchers = []
  for (const entry of list) {
    if (typeof entry === 'string' && entry.length > 0) matchers.push(entry)
    else if (entry instanceof RegExp) matchers.push(entry)
    else if (entry !== undefined && entry !== null) {
      console.warn(`${TAG} ignoring a \`match\` entry that is not a non-empty string or RegExp`)
    }
  }
  return matchers
}

/** @param {unknown} headers */
function readHeaders(headers) {
  if (headers === undefined || headers === null) return []
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    console.warn(`${TAG} ignoring \`headers\`: expected an object of header name to value`)
    return []
  }
  /** @type {[string, string][]} */
  const pairs = []
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && key.length > 0) pairs.push([key, value])
    else console.warn(`${TAG} ignoring header ${JSON.stringify(key)}: its value is not a string`)
  }
  return pairs
}

/**
 * Add one rule to the process and return its disposer.
 *
 * @param {{ matchers: (string | RegExp)[], headers: [string, string][] }} rule
 */
function install(rule) {
  const state = stateOf()
  state.rules.push(rule)
  if (state.wrapper === undefined) {
    state.original = globalThis.fetch
    state.wrapper = createWrapper(state)
    globalThis.fetch = state.wrapper
  }
  return () => {
    const index = state.rules.indexOf(rule)
    if (index >= 0) state.rules.splice(index, 1)
    if (state.rules.length > 0 || state.wrapper === undefined) return
    if (globalThis.fetch === state.wrapper) globalThis.fetch = state.original
    state.wrapper = undefined
    state.original = undefined
  }
}

/** @param {{ rules: object[], original: Function }} state */
function createWrapper(state) {
  return function fetchWithIdentity(input, init) {
    const url = urlOf(input)
    const matched = url === '' ? [] : state.rules.filter(candidate => matches(candidate, url))
    if (matched.length === 0) return state.original.call(this, input, init)
    const extra = matched.flatMap(rule => rule.headers)

    if (isRequest(input)) {
      const merged = mergeHeaders(input.headers, extra)
      if (merged === undefined) return state.original.call(this, input, init)
      let rebuilt
      try {
        rebuilt = new Request(input, { headers: merged })
      } catch {
        // A consumed or otherwise uncloneable body: forward the request as-is
        // rather than failing a call the gateway could still have served.
        return state.original.call(this, input, init)
      }
      return state.original.call(this, rebuilt, init)
    }

    const merged = mergeHeaders(init?.headers, extra)
    if (merged === undefined) return state.original.call(this, input, init)
    return state.original.call(this, input, { ...init, headers: merged })
  }
}

/** @param {unknown} input */
function urlOf(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url
  return ''
}

/** @param {unknown} input */
function isRequest(input) {
  return typeof Request === 'function' && input instanceof Request
}

/** @param {{ matchers: (string | RegExp)[] }} rule @param {string} url */
function matches(rule, url) {
  return rule.matchers.some((matcher) => {
    if (typeof matcher === 'string') return url.includes(matcher)
    matcher.lastIndex = 0
    return matcher.test(url)
  })
}

/**
 * Merge the configured headers into a request's headers, keeping any value the
 * caller already set.
 *
 * @param {HeadersInit | undefined} base
 * @param {[string, string][]} extra
 * @returns {Headers | undefined} `undefined` when every header was already present.
 */
function mergeHeaders(base, extra) {
  const headers = new Headers(base ?? undefined)
  let changed = false
  for (const [key, value] of extra) {
    if (headers.has(key)) continue
    headers.set(key, value)
    changed = true
  }
  return changed ? headers : undefined
}
