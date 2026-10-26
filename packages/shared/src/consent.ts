/**
 * 准入声明（草案 14.14.5）：九条最小集，逐条勾选，全勾才可进入。
 *
 * 红线：勾选前不进应用、无快速同意、不代勾、文案版本化（改文案即新版本需重勾）。
 * 这里只放文案与结构；勾选状态与记录由内核持久化到 user_consents。
 */
import type { ConsentItem } from "./domain.js";

export const CONSENT_ITEMS: ConsentItem[] = [
  {
    id: "c1",
    title: "这是一个 AI 拟人智能体",
    body: "Anteros 是一个由大语言模型驱动的软件程序，它可能说话很像真人，但它不是真人。",
    required: true,
  },
  {
    id: "c2",
    title: "它可能像真人，但不是真人",
    body: "它的记忆、情绪、日常与关系都是程序模拟出来的，不存在真实的意识、感受或线下身体。",
    required: true,
  },
  {
    id: "c3",
    title: "不能作为事实的唯一来源",
    body: "它说的话可能有误、可能记错、可能编造细节。请不要把它的输出作为医疗、法律、财务或重大情感决策的唯一依据。",
    required: true,
  },
  {
    id: "c4",
    title: "外部通道会读写你的本机客户端",
    body: "启用任何外部通道插件（例如微信通道）后，该插件会读取本机客户端的本地数据库、并模拟操作客户端界面来发送消息，这可能影响你的账号安全，甚至导致账号被限制或封禁。是否启用由你逐项决定，默认关闭。",
    required: true,
  },
  {
    id: "c5",
    title: "不得用于伤害他人",
    body: "不得使用 Anteros 进行诈骗、骚扰、勒索、冒充他人、骗取财物或其他违法活动。使用者承担全部法律责任。",
    required: true,
  },
  {
    id: "c6",
    title: "不还原、不备份他人撤回的消息",
    body: "Anteros 不会反制撤回、不会备份他人的已撤回消息。撤回只会被记录为「对方撤回了一条消息」，正文不落库、不展示、不上传。",
    required: true,
  },
  {
    id: "c7",
    title: "密钥与数据不出本机",
    body: "外部通道所需的密钥、解密后的数据库内容只在本机使用，不上传云端。调用大模型 API 时只会发送装配后的对话上下文，不会发送密钥或原始数据库。",
    required: true,
  },
  {
    id: "c8",
    title: "你随时可以停用并清空",
    body: "你可以随时一键停用所有通道插件、导出或删除本机数据。停用后外部客户端会被还原，不留下自动化痕迹。",
    required: true,
  },
  {
    id: "c9",
    title: "未满 18 岁请勿使用",
    body: "本软件面向成年人。未满 18 周岁请勿使用。",
    required: true,
  },
];

export const CONSENT_ITEM_IDS = CONSENT_ITEMS.map((item) => item.id);