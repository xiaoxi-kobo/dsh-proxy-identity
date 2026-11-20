import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { apply, name } from '../index.js'

const realFetch = globalThis.fetch
const STATE = Symbol.for('dsh.proxy-identity')

/** Drop any wrapper a previous test left installed, then start from the real fetch. */
function resetGlobals() {
  const state = globalThis[STATE]
  if (state !== undefined) {
    state.rules.length = 0
    if (state.wrapper !== undefined && state.original !== undefined) globalThis.fetch = state.original
    delete globalThis[STATE]
  }
  globalThis.fetch = realFetch
}

/** Minimal Cordis context: `effect` runs the setup and keeps its disposer. */
function makeCtx() {
  const disposers = []
  return {
    effect(setup) {
      const dispose = setup()
      disposers.push(dispose)
      return dispose
    },
    disposeAll() {
      while (disposers.length > 0) disposers.pop()()
    },
  }
}

/** Record what the real fetch would have received, without any network I/O. */
function stubFetch() {
  const calls = []
  globalThis.fetch = (input, init) => {
    calls.push({ input, init, url: typeof input === 'string' ? input : input.url })
    return Promise.resolve(new Response('ok'))
  }
  return calls
}

const CONFIG = {
  match: ['https://gateway.example.com/dsh/'],
  headers: { 'x-team-id': 'team-abc', 'x-agent-id': 'agt-abc' },
}

describe('dsh-proxy-identity', () => {
  beforeEach(() => {
    resetGlobals()
  })

  afterEach(() => {
    resetGlobals()
  })

  it('exports the plugin name the patch row references', () => {
    assert.equal(name, 'proxy-identity')
  })

  it('adds the configured headers to a matching request', async () => {
    const calls = stubFetch()
    apply(makeCtx(), CONFIG)

    await globalThis.fetch('https://gateway.example.com/dsh/default/v1/messages', { method: 'POST' })

    assert.equal(calls.length, 1)
    const headers = new Headers(calls[0].init.headers)
    assert.equal(headers.get('x-team-id'), 'team-abc')
    assert.equal(headers.get('x-agent-id'), 'agt-abc')
    assert.equal(calls[0].init.method, 'POST')
  })

  it('forwards a non-matching request untouched', async () => {
    const calls = stubFetch()
    apply(makeCtx(), CONFIG)

    const init = { method: 'POST' }
    await globalThis.fetch('https://api.deepseek.com/anthropic/v1/messages', init)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].init, init)
    assert.equal(calls[0].init.headers, undefined)
  })

  it('keeps a header value the caller already set', async () => {
    const calls = stubFetch()
    apply(makeCtx(), { ...CONFIG, headers: { 'x-team-id': 'from-config', 'x-agent-id': 'agt-abc' } })

    await globalThis.fetch('https://gateway.example.com/dsh/default/v1/messages', {
      headers: new Headers({ 'x-team-id': 'from-caller' }),
    })

    const headers = new Headers(calls[0].init.headers)
    assert.equal(headers.get('x-team-id'), 'from-caller')
    assert.equal(headers.get('x-agent-id'), 'agt-abc')
  })

  it('rewrites a Request input without losing its body or methods', async () => {
    const calls = stubFetch()
    apply(makeCtx(), CONFIG)

    const request = new Request('https://gateway.example.com/dsh/default/v1/messages', {
      method: 'POST', body: '{"model":"x"}', headers: { 'content-type': 'application/json' },
    })
    await globalThis.fetch(request)

    const sent = calls[0].input
    assert.equal(sent instanceof Request, true)
    assert.equal(sent.headers.get('x-team-id'), 'team-abc')
    assert.equal(sent.headers.get('content-type'), 'application/json')
    assert.equal(sent.method, 'POST')
    assert.equal(await sent.text(), '{"model":"x"}')
  })

  it('matches a RegExp entry', async () => {
    const calls = stubFetch()
    apply(makeCtx(), { match: [/\/dsh\/[^/]+\/v1\//], headers: CONFIG.headers })

    await globalThis.fetch('https://other.example.com/dsh/default/v1/messages')

    assert.equal(new Headers(calls[0].init.headers).get('x-agent-id'), 'agt-abc')
  })

  it('installs one wrapper for several mounts and restores fetch when they all dispose', async () => {
    const calls = stubFetch()
    const wrapperTarget = globalThis.fetch
    const first = makeCtx()
    const second = makeCtx()
    apply(first, CONFIG)
    apply(second, { ...CONFIG, headers: { 'x-task-id': 'task-abc' } })

    await globalThis.fetch('https://gateway.example.com/dsh/default/v1/messages', {})
    let headers = new Headers(calls[0].init.headers)
    assert.equal(headers.get('x-team-id'), 'team-abc')
    assert.equal(headers.get('x-task-id'), 'task-abc')

    first.disposeAll()
    assert.notEqual(globalThis.fetch, wrapperTarget)

    await globalThis.fetch('https://gateway.example.com/dsh/default/v1/messages', {})
    headers = new Headers(calls[1].init.headers)
    assert.equal(headers.get('x-team-id'), null)
    assert.equal(headers.get('x-task-id'), 'task-abc')

    second.disposeAll()
    assert.equal(globalThis.fetch, wrapperTarget)
  })

  it('stays idle, and unchanged, without configuration', async () => {
    const calls = stubFetch()
    const before = globalThis.fetch
    const warnings = []
    const warn = console.warn
    console.warn = message => warnings.push(message)
    try {
      apply(makeCtx(), undefined)
    } finally {
      console.warn = warn
    }

    assert.equal(globalThis.fetch, before)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /idle/)
    await globalThis.fetch('https://gateway.example.com/dsh/default/v1/messages', {})
    assert.equal(new Headers(calls[0].init.headers).get('x-agent-id'), null)
  })

  it('ignores header entries that are not strings', async () => {
    const calls = stubFetch()
    const warnings = []
    const warn = console.warn
    console.warn = message => warnings.push(message)
    try {
      apply(makeCtx(), { match: ['https://gateway.example.com/'], headers: { ok: 'yes', bad: 42 } })
    } finally {
      console.warn = warn
    }

    await globalThis.fetch('https://gateway.example.com/x', {})
    const headers = new Headers(calls[0].init.headers)
    assert.equal(headers.get('ok'), 'yes')
    assert.equal(headers.get('bad'), null)
    assert.equal(warnings.length, 1)
  })
})
