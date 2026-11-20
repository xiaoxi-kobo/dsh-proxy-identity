# dsh-proxy-identity

[English](README.md) | 中文

给每个模型请求带上固定的身份请求头，让共享网关认得这个 DeepSeek Harness 客户端，而不是反过来要求客户端去做一个它做不了的交互选择。

## 为什么需要

有些摆在 Anthropic 兼容端点前面的网关 —— 团队 LLM 路由、自建记忆代理、按 agent 分片的记忆网管 —— 靠**自己约定的请求头**（例如 `x-team-id`、`x-agent-id`）判断调用方是谁。缺这些头时，网关会退回交互选择：它用一个假 tool call 回答模型请求，等用户在表单里选团队和 agent。

能渲染表单的聊天客户端没问题。但表面不支持的客户端，或者一天要新开二十个会话的人，就很吃亏：每个会话都要回答同一个问题，而不回答就什么都不会挂上。这个插件把这个问题在配置里回答一次，之后每个请求都带上。

它刻意不绑定任何具体网关：不知道代理是谁，也不知道这些头的含义。你给出 URL 片段和请求头，它照做。

## 行为

- 当请求 URL 包含配置的某个片段（或匹配配置的正则）时，补上配置的请求头。
- 其它请求一律原样转发，参数保持调用方传入的样子。
- 调用方已经设置的头不覆盖：配置只填空缺。
- 无论挂载多少次，一个进程只装一层包装；最后一个挂载销毁时恢复原始 `fetch`。
- 从不打印请求头的值。

## 安装

```sh
dsh plugin --profile web add github:xiaoxi-ai/dsh-proxy-identity
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 里配置。patch 会整体替换一行的 `config`，所以要写全需要的键：

```yaml
- id: proxy-identity
  config:
    match:
      - https://gateway.example.com/dsh/
    headers:
      x-team-id: team-0000000000
      x-agent-id: agt-0000000000
```

启动前可用 `dsh --profile web --dump-config` 查看合成后的配置层。卸载：`dsh plugin --profile web remove dsh-proxy-identity`。

### 配置项

| 键 | 类型 | 含义 |
|---|---|---|
| `match` | 字符串 \| (字符串 \| RegExp) 数组 | URL 包含该字符串或匹配该正则时才会被处理。必填，不填不注入任何东西。 |
| `headers` | 字符串到字符串的对象 | 要补的请求头与值。非字符串值会被忽略并告警。必填。 |

一个请求命中多条规则时，请求头取并集，先挂载的优先；已存在的头不会被覆盖。

## 已知限制

- 包装的是 `globalThis.fetch` —— 官方 DeepSeek adapter 就是用它发请求。它只增删自己的请求头，但这是进程级补丁，不是官方扩展点：进程里其它访问匹配 URL 的代码也会被加上这些头。
- 传入的 `Request` 若 body 已被消费，则原样转发，而不是报错。
- 请求头的值以明文存在于 profile patch 里（本机文件）。这里放身份标签，不要放密钥；凭据属于凭据存储。

## 测试

```sh
npm test
```

`node --test`，零依赖，不出网：测试里装一个记录型 `fetch`，断言哪些请求带了哪些头。

## 许可

MIT
