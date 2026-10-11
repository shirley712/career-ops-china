# Mode: feishu — 飞书集成的配置 / 授权 / 体检入口

> 飞书是**可选插件层**。这个项目是开源的，绝大多数使用者不会接飞书 —— 所以核心流程
> （评估 / tracker / PDF / scan）永远不依赖它。关掉之后每个飞书动作返回 `{skipped:true}`，
> 调用方打印一行降级提示继续跑。**验收方式就是把 `feishu.enabled` 改成 false 跑一遍全流程。**

## 先跑体检

```bash
npm run feishu:check
```

它分开告诉你三件独立的事坏在哪一件 —— 这三者的报错长得很像，混在一起能浪费一下午：

| 维度 | 看什么 | 坏了的症状 |
|---|---|---|
| **开关** | `config/profile.yml` 的 `feishu.enabled` + `capabilities.*` | 调用静默 skip，像是"没反应" |
| **身份** | `lark-cli auth status --profile <p>` 能不能解析出 user | 所有命令报错，像是缺权限 |
| **scope** | token 实际带的 scope 字符串 | 读得到、写就炸（`91403` / `missing_scope`） |

## 能力清单

| capability | 作用 | 需要的 scope | 碰不到飞书时的降级 |
|---|---|---|---|
| `bitable` | tracker 后端 | `base:record:*` `base:field:read` | 切 `tracker.backend: md` |
| `calendar` | 面试日程（JD 摘要塞进日程描述） | `calendar:calendar.event:create` `calendar:calendar.free_busy:read` | 写 `data/reminders.md` |
| `task` | 跟进提醒 + 面试前 24h 过简历 | `task:task:read` `task:task:write` | 写 `data/reminders.md` |
| `im_card` | 每日摘要推到自己单聊 | `im:message.send_as_user` | 打印到 stdout |
| `dashboard` | Bitable 仪表盘 / 云端聚合 | 复用 `base:dashboard:*` | 本地 `aggregateByStatus()` |
| `docs` | 简历 / 报告上云 | `drive:file:upload` `docx:document:create` | 文件留在 `output/` |

⚠️ `bitable` 是例外：它早于 `feishu:` 段存在，实际开关仍是 `tracker.backend`，`capabilities.bitable` 只作记录。

## 日常用法

```bash
npm run feishu:check                  # 体检
npm run feishu:digest -- --dry-run    # 看今天的日报长什么样（不发送）
npm run feishu:digest                 # 真发到自己单聊
```

代码里：

```js
import { createInterviewEvent, createFollowUpTask, suggestSlots } from './tools/feishu/schedule.mjs';

// Status → Interview：建日程，并自动挂一个「面试前 24h 过简历一致性」的任务
createInterviewEvent({ num, company, role, start: '2026-10-15T14:00:00+08:00', description: jdSummaryMarkdown });

// Status → Applied：挂一个 +3 天的跟进任务
createFollowUpTask({ num, company, role });

// HR 问「你哪天方便」
suggestSlots({ start, end, durationMin: 60 });
```

**每个写动作都支持 `dryRun: true`** —— 透传 lark-cli 自己的 `--dry-run`，打印将要发出的 request
而不产生任何外部动作。往别人的租户里建日程、发消息是不可逆的，所以改完代码先 dry-run 一遍。
这个习惯已经抓到过一个真 bug：`task +create --due` 的 help 写着支持 `relative:+2d`，实际解析器只认
ISO 8601 / Unix 时间戳。

## 新增 scope 的流程（别直接 auth login 乱扫码）

顺序是有讲究的，每一步都能让你少扫一次码：

1. `lark-cli auth scopes --profile <p>` —— 看 **app 侧**开了哪些。**app 没开的 scope，用户授权也拿不到**，这步能避免白扫一次码
2. `lark-cli auth check --profile <p> --scope "<具体 scope>"` —— 已有就整个跳过
   （注意是 `--scope`，**没有 `--domain` 这个参数**）
3. `lark-cli schema <service.resource.method>` —— 查准确的 scope 字符串，**别凭记忆写**
4. `lark-cli auth login --profile <p> --scope "<具体 scope>" --no-wait --json` 拿 verification_url
   → 出二维码给用户 → **当轮结束交还控制权** → 用户确认后再 `--device-code <code>`

scope 是**累加**的，按最小权限加，不要一次把 23 个域全要了。

## 铁律

- **每条 lark-cli 命令必带 `--profile`。** CLI 的默认 profile 是全局可变状态，别的会话跑一次
  `lark-cli profile use` 就会把写入静默打到另一个租户。所以所有调用只能走
  `tools/feishu/capabilities.mjs` 的 `runLarkCli()` —— 它强制注入 `--profile`、`--format json`、
  写操作加 `--as user`、并节流到 ~5 req/s。未配置 profile 时**抛错，绝不回落默认值**。
- **永不自行加 `--yes`。** 破坏性操作（`+record-delete` / `+field-delete` / `+view-delete` /
  `+field-update`）需要它，而 CLI 明确要求 agent 不得自己加 —— 这类操作只打印命令，交给用户执行。
- **禁止 `lark-cli profile use`**（改全局默认）和 **`profile remove`**（销毁凭证）。
- **禁止把 appSecret 打到终端或写进任何文件。** 体检脚本只打印 name + open_id，不打印整个 auth payload
  （里面有 token 状态）。
- `whoami` 和 `auth status` 吃 `--json`，**不吃 `--format json`** —— 传错是 usage error。

## 已知边界

- **`base` 不在 `event` 的 8 个域里** —— Bitable 记录变更**没有事件流**。所以「改 Status 自动建日程」
  只能靠主动调用或轮询，不存在 webhook 方案。这也是日报走 cron 式 bounded run、不留守进程的原因。
- **卡片按钮回写不做**（用户决定留后期）。前置条件：单向推送跑顺 + 用户确实觉得去 Bitable 改状态麻烦。
  真要做需要 `event consume card.action.trigger` 的常驻监听。
- **view filter 对 formula 字段的数值比较会静默失效**（API 返回 ok 但记录数不对）。filter 只打原生存储
  字段，formula 只用于展示和排序。
- `calendar +create` 默认会带一个 VC 会议和 5 分钟前提醒 —— 不想要就得显式覆盖。

## 相关文件

| 文件 | 作用 |
|---|---|
| `tools/feishu/capabilities.mjs` | **唯一的 lark-cli 出口** + 能力注册表 + scope 清单 |
| `tools/feishu/schedule.mjs` | calendar + task |
| `tools/feishu/notify.mjs` | 每日摘要单向推送 |
| `tools/feishu/check.mjs` | `npm run feishu:check` |
| `tools/backends/bitable-backend.mjs` | tracker 的 Bitable 后端（走同一个出口） |
| `data/reminders.md` | 降级台账（gitignored —— 带公司名和投递编号） |
| `CLAUDE.md` 的「lark-cli 集成铁律」段 | 15 条踩坑 + 性能陷阱 |
