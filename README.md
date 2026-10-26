
# codex-no-stop

让 Codex CLI 遇到下面这类错误时**自动等待并重试**，而不是直接把回合结束掉：

```
Selected model is at capacity. Please try a different model.
server_is_overloaded / rate limit / 429 / 5xx ...
```

只需要把命令从 `codex` 换成 `codex-retry`，其他用法、参数完全一样。

**它不会修改你的 `~/.codex/config.toml`，也不会碰你的 token、模型和 provider 设置。**
`codex-retry` 只是在启动 Codex 时临时把「请求地址」指向本机的一个小代理，
代理遇到上面这些错误时自己重试，成功了再把结果交回给 Codex。

## 需要什么

- Windows
- Node.js（<https://nodejs.org/> 装 LTS 版即可）
- 已经装好并在用的 Codex CLI（`codex` 命令能正常运行）
- `~/.codex/config.toml` 里用的是**自定义 provider**（即写过 `base_url`，比如各种中转）

## 安装

> 下载地址：<https://github.com/csskrtao/codex-no-stop>（右上角 Code → Download ZIP）

1. 把整个文件夹解压到一个**固定的位置**，例如 `C:\codex-no-stop`
   （装好后不要移动或删除，否则 `codex-retry` 会失效）
2. 双击 `install.cmd`
3. 看到 `Done. Use codex-retry instead of codex.` 就装好了

安装脚本会自动读取你的 `config.toml`，找出你当前用的 provider 和它的 `base_url`，
不需要手动填任何东西。

## 使用

```bat
codex-retry                            :: 交互式界面，和 codex 一样
codex-retry exec "修复这个 bug"
codex-retry exec --skip-git-repo-check -s read-only "解释这段代码"
codex-retry resume --last
```

- 代理没在运行时，`codex-retry` 会自动在后台把它启动起来，不用管。
- 直接输 `codex` 时**不会**走代理，行为和原来完全一样。

重试发生时你会在终端里看到 Codex 停在那里等一下，然后继续，不会报错退出。

## 重试统计

- **运行中**：一旦发生重试，终端窗口/标签标题会变成
  `Codex · 重试 3 次 · 上次 12:34:56`（本次运行内累计，每 2 秒刷新）
- **退出时**：Codex 结束后打印一行
  `codex-no-stop: 本次重试 2 次（累计 37 次），上次重试 2026-10-26 12:34:56`
- **接口**：<http://127.0.0.1:8788/__stats>
- 累计数存在 `proxy/retry-stats.json`，重启代理不会清零

> Codex 的 TUI 状态栏只能从固定几项里挑（模型、分支、context、token 数等），
> 不支持自定义文字，所以统计放在终端标题和退出提示里。

## 看看它做了什么

- 日志：本文件夹里的 `proxy.log`，每次重试的原因和等待时间都在里面，例如
  ```
  POST /v1/responses attempt 4/100: stream response.failed: ... at capacity ...; retrying in 16.1s
  POST /v1/responses: succeeded on attempt 6 after 160404ms
  ```
- 代理状态：<http://127.0.0.1:8788/__health>

## 常用脚本

| 文件 | 作用 |
| --- | --- |
| `install.cmd` | 安装（只做一次） |
| `codex-retry.cmd` | 包装器，日常就用它 |
| `start-proxy.cmd` | 手动前台启动代理（调试用，会显示报错） |
| `stop-proxy.cmd` | 停止代理 |
| `uninstall.cmd` | 卸载：停止代理、删掉全局的 `codex-retry` 命令 |

## 可调参数

想改的话，直接编辑安装后生成的 `settings.cmd`：

```bat
set "CODEX_PROVIDER=custom"                  :: 你的 provider 名，安装时自动填
set "CODEX_UPSTREAM=https://你的中转域名"     :: 上游地址，安装时自动填
set "CODEX_BASE_PATH=/v1"                    :: 安装时自动填
set "CODEX_RETRY_PORT=8788"                  :: 本机端口，被占用时可以改
```

重试策略相关的环境变量（一般不用动）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CODEX_RETRY_MAX` | `100` | 单个请求最多重试多少次 |
| `CODEX_RETRY_BASE_MS` | `2000` | 首次退避时长，之后指数增长 |
| `CODEX_RETRY_MAX_DELAY_MS` | `20000` | 单次等待上限（服务器给了 `Retry-After` 时最多 60 秒） |
| `CODEX_RETRY_GRACE_MS` | `3000` | 流开始后等错误事件的宽限期 |

## 说明 / 限制

- **开着 Clash（或其他系统代理）也可以用。** Codex 会读 Windows 的系统代理设置，
  系统代理开着时它会把发往 `127.0.0.1:8788` 的请求也交给代理软件，导致 `502 Bad Gateway`
  （此时 `proxy.log` 里不会有任何记录）。`codex-retry` 会自动设置
  `NO_PROXY=127.0.0.1,localhost,::1` 让 Codex 直连本地代理，其他流量照旧走你的代理。
- **只重试“还没开始输出内容”的失败。** 如果错误发生在 Codex 已经开始收到文字之后，
  就没法重试了（否则会出现重复内容），会原样报给 Codex。
- 重试会重复消耗上游额度——失败的那次请求本身已经发出去了，这是自动重试的固有代价。
- 换中转、换 token、换模型都不用重装，只有**改 `base_url`** 之后需要重新跑一次 `install.cmd`。
- Codex 升级不需要重装，`codex-retry` 每次调用的就是你自己装的那个 `codex`。
- 卸载：双击 `uninstall.cmd`，然后删掉这个文件夹；`config.toml` 从来没有被改过，无需还原。

## 原理

```
codex-retry ──> Codex ──> 127.0.0.1:8788 ──> 你的中转
                                │
                                └─ capacity / overloaded / 429 / 5xx / response.failed
                                   在本地等待后重试，Codex 根本看不到这个错误
```

Codex 0.163.0 会把这句 capacity 报错归类成“不可重试”的错误直接结束回合，
内置的重试配置和 hook 都拦不住（失败回合连 Stop hook 都不触发），
所以在外面套一层本地代理是唯一可靠的办法。

感谢 Linux.do 社区成员长期以来的支持与分享
