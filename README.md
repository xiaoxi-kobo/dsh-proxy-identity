# dsh-proxy-identity

English | [中文](README.zh.md)

Attach fixed identity headers to every model request, so a shared model gateway recognizes the DeepSeek Harness client instead of asking it to pick something it cannot pick.

## Why

Some gateways in front of an Anthropic-compatible endpoint — a team LLM router, a self-hosted memory proxy, a gateway that scopes memory per agent — identify the caller from request headers they define themselves (for example `x-team-id` and `x-agent-id`). When those headers are missing, the gateway falls back to an interactive picker: it answers the model request with a fake tool call and waits for the user to choose a team and an agent.

A chat client renders that picker. A client whose surface does not, or a user who opens a new conversation twenty times a day, gets a worse deal: the same question every session, and nothing attached when the answer never comes. This plugin answers the question once, in configuration, and sends it on every request.

It is deliberately gateway-agnostic: it knows nothing about any particular proxy or about what the headers mean. You name the URLs and the headers; it adds them.

## What it does

- Adds the configured headers to model requests whose URL contains one of the configured fragments (or matches one of the configured regular expressions).
- Forwards every other request untouched, with the same arguments the caller passed.
- Keeps any value the caller already set: configuration only fills gaps.
- Installs one wrapper per process no matter how many times it mounts, and restores the original `fetch` when the last mount disposes.
- Never logs header values.

## Install

```sh
dsh plugin --profile web add github:xiaoxi-ai/dsh-proxy-identity
```

Then configure it in `~/.dsh/profiles/web/cordis.patch.yml`. A patch replaces a row's whole `config`, so restate every key you need:

```yaml
- id: proxy-identity
  config:
    match:
      - https://gateway.example.com/dsh/
    headers:
      x-team-id: team-0000000000
      x-agent-id: agt-0000000000
```

`dsh --profile web --dump-config` shows the composed layer before you boot. Remove the plugin with `dsh plugin --profile web remove dsh-proxy-identity`.

### Configuration

| Key | Type | Meaning |
|---|---|---|
| `match` | string \| array of (string \| RegExp) | A request is touched when its URL contains a string entry or matches a RegExp entry. Required; nothing is injected without it. |
| `headers` | object of string to string | Header names and values to add. Non-string values are ignored with a warning. Required. |

A request matching several mounted rules receives the union of their headers, earlier mounts first; a header already present is never overwritten.

## Limitations

- The wrapper patches `globalThis.fetch`, which is what the shipped DeepSeek adapters use to reach their endpoint. It adds and removes only its own headers, but it is a process-wide patch rather than a first-party seam: it also touches any other code in the process that fetches a matching URL.
- Requests built from a `Request` whose body was already consumed are forwarded unchanged instead of failing.
- Header values are stored in plain text in the profile patch, which lives on your machine. Use it for identity labels, not secrets; credentials belong in the credential store.

## Test

```sh
npm test
```

`node --test`, no dependencies, nothing reaches the network: the suite installs a recording `fetch` and asserts which requests carry which headers.

## License

MIT
