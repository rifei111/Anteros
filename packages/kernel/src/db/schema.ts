/**
 * SQLite schema —— 《工程规范 1：数据契约》的单机闭环落地版。
 *
 * 规范 1 §1 的存储选型原本是 PostgreSQL + pgvector（云端形态）；草案 14.15 明确
 * M0–M2 是单机闭环：「数据 = SQLite + 媒体目录，全在本机」。因此这里做等价翻译：
 * - bigserial → INTEGER PRIMARY KEY（自增）
 * - jsonb → TEXT（JSON 字符串，写入前由 service 层 zod 校验）
 * - text[] → TEXT（JSON 数组）
 * - timestamptz/ts 一律 bigint → INTEGER（UTC 毫秒）
 * 字段名与语义保持与规范 1 一致，便于回看契约。
 *
 * 不可协商的三条（规范 1 §0）：
 * 1. 时间一律 UTC 毫秒；
 * 2. agents.epoch 是动作作废阈值，用户产生新输入即 +1；
 * 3. 单一写入入口：只有 service 层写库，不允许应用层直接 UPDATE。
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tz          TEXT NOT NULL,
  locale      TEXT NOT NULL DEFAULT 'zh-CN',
  created_ts  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  role        TEXT NOT NULL DEFAULT 'member',
  deletion_ts INTEGER
);

CREATE TABLE IF NOT EXISTS personas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  birth_ts      INTEGER NOT NULL,
  city          TEXT NOT NULL,
  traits        TEXT NOT NULL,
  interests     TEXT NOT NULL,
  immutable     TEXT NOT NULL,
  speech_style  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  persona_id    INTEGER NOT NULL REFERENCES personas(id),
  created_ts    INTEGER NOT NULL,
  epoch         INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 0,
  mode          TEXT NOT NULL DEFAULT 'standard'
);

CREATE TABLE IF NOT EXISTS owners (
  user_id   INTEGER PRIMARY KEY REFERENCES users(id),
  wechat_id TEXT NOT NULL UNIQUE,
  build_id  TEXT NOT NULL,
  bound_ts  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_consents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  doc_version  TEXT NOT NULL,
  accepted_ts  INTEGER NOT NULL,
  channel      TEXT NOT NULL,
  ip_hash      TEXT,
  checked_ids  TEXT NOT NULL DEFAULT '[]',
  revoked_ts   INTEGER,
  UNIQUE (user_id, doc_version, channel)
);

CREATE TABLE IF NOT EXISTS plugins (
  id            TEXT PRIMARY KEY,
  version       TEXT NOT NULL,
  kernel_api    TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'processor',
  capabilities  TEXT NOT NULL DEFAULT '[]',
  permissions   TEXT NOT NULL DEFAULT '[]',
  risk_level    TEXT NOT NULL DEFAULT 'low',
  enabled       INTEGER NOT NULL DEFAULT 0,
  config        TEXT NOT NULL DEFAULT '{}',
  enabled_ts    INTEGER,
  installed_by  INTEGER,
  status        TEXT NOT NULL DEFAULT 'disabled',
  health        TEXT,
  last_error    TEXT,
  issues        TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS plugin_grants (
  plugin_id  TEXT NOT NULL REFERENCES plugins(id),
  capability TEXT NOT NULL,
  granted_ts INTEGER NOT NULL,
  revoked_ts INTEGER,
  PRIMARY KEY (plugin_id, capability)
);

CREATE TABLE IF NOT EXISTS style_habits (
  agent_id   INTEGER NOT NULL,
  phrase     TEXT NOT NULL,
  first_ts   INTEGER NOT NULL,
  last_ts    INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 1,
  accepted   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, phrase)
);

CREATE TABLE IF NOT EXISTS memory_episodic (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id       INTEGER NOT NULL,
  t_start_ts     INTEGER NOT NULL,
  t_end_ts       INTEGER,
  text           TEXT NOT NULL,
  entities       TEXT NOT NULL DEFAULT '[]',
  emotion_v      REAL,
  emotion_a      REAL,
  salience       REAL NOT NULL DEFAULT 1,
  importance     TEXT NOT NULL DEFAULT 'detail',
  layer          TEXT NOT NULL DEFAULT 'detail',
  confidence     REAL NOT NULL DEFAULT 0.8,
  source         TEXT NOT NULL DEFAULT 'user_said',
  source_ref     TEXT,
  access_log     TEXT NOT NULL DEFAULT '[]',
  last_access_ts INTEGER,
  deleted_ts     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_episodic_agent_access ON memory_episodic (agent_id, last_access_ts DESC);

CREATE TABLE IF NOT EXISTS memory_semantic (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL,
  slot_key      TEXT NOT NULL,
  value         TEXT NOT NULL,
  confidence    REAL NOT NULL,
  importance    TEXT NOT NULL DEFAULT 'detail',
  evidence      TEXT NOT NULL DEFAULT '[]',
  created_ts    INTEGER NOT NULL,
  updated_ts    INTEGER NOT NULL,
  superseded_by INTEGER,
  deleted_ts    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_current
  ON memory_semantic (agent_id, slot_key) WHERE superseded_by IS NULL AND deleted_ts IS NULL;

CREATE TABLE IF NOT EXISTS memory_open_loops (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL,
  topic         TEXT NOT NULL,
  opened_ts     INTEGER NOT NULL,
  last_touch_ts INTEGER NOT NULL,
  closed_ts     INTEGER,
  urgency       REAL NOT NULL DEFAULT 0.5,
  pinned_until  INTEGER,
  source_ref    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_open_loops_agent ON memory_open_loops (agent_id, closed_ts, last_touch_ts DESC);

CREATE TABLE IF NOT EXISTS memory_persona (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id  INTEGER NOT NULL,
  slot_key  TEXT NOT NULL,
  value     TEXT NOT NULL,
  mutable   INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_slot ON memory_persona (agent_id, slot_key);

CREATE TABLE IF NOT EXISTS narrative_slots (
  agent_id   INTEGER NOT NULL,
  slot_key   TEXT NOT NULL,
  value      TEXT NOT NULL,
  prose      TEXT,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (agent_id, slot_key)
);

CREATE TABLE IF NOT EXISTS relation_state (
  agent_id           INTEGER PRIMARY KEY,
  stage              TEXT NOT NULL DEFAULT 'stranger',
  intimacy           REAL NOT NULL DEFAULT 0,
  trust              REAL NOT NULL DEFAULT 0.5,
  mode               TEXT NOT NULL DEFAULT 'standard',
  since_ts           INTEGER NOT NULL,
  last_transition_ts INTEGER,
  transition_log     TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS drives_state (
  agent_id       INTEGER PRIMARY KEY,
  loneliness     REAL NOT NULL DEFAULT 0,
  boredom        REAL NOT NULL DEFAULT 0,
  longing        REAL NOT NULL DEFAULT 0,
  tension        REAL NOT NULL DEFAULT 0,
  fatigue        REAL NOT NULL DEFAULT 0,
  urge_to_share  REAL NOT NULL DEFAULT 0,
  anxiety        REAL NOT NULL DEFAULT 0,
  params         TEXT NOT NULL DEFAULT '{}',
  updated_ts     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roster (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   INTEGER NOT NULL,
  name       TEXT NOT NULL,
  relation   TEXT NOT NULL,
  traits     TEXT NOT NULL DEFAULT '{}',
  history    TEXT NOT NULL DEFAULT '[]',
  unresolved TEXT,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS decision_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  situation     TEXT NOT NULL,
  options       TEXT NOT NULL DEFAULT '[]',
  chosen        TEXT NOT NULL,
  given_up      TEXT NOT NULL,
  user_reaction TEXT,
  turn_id       INTEGER
);

CREATE TABLE IF NOT EXISTS life_calendar (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     INTEGER NOT NULL,
  start_ts     INTEGER NOT NULL,
  end_ts       INTEGER NOT NULL,
  activity     TEXT NOT NULL,
  location_tag TEXT,
  energy_cost  REAL,
  public       INTEGER NOT NULL DEFAULT 1,
  source       TEXT NOT NULL DEFAULT 'persona'
);

CREATE TABLE IF NOT EXISTS device_feed (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL,
  item_id     TEXT NOT NULL,
  topic       TEXT NOT NULL DEFAULT '[]',
  source_url  TEXT,
  fetched_ts  INTEGER NOT NULL,
  consumed_ts INTEGER,
  reaction    REAL,
  shared_ts   INTEGER
);

CREATE TABLE IF NOT EXISTS presence_state (
  agent_id  INTEGER PRIMARY KEY,
  state     TEXT NOT NULL DEFAULT 'idle',
  since_ts  INTEGER NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  source    TEXT NOT NULL DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL,
  role          TEXT NOT NULL,
  text          TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  turn_id       INTEGER,
  part_index    INTEGER,
  recalled      INTEGER NOT NULL DEFAULT 0,
  client_ack_ts INTEGER,
  channel_id    TEXT NOT NULL DEFAULT 'app',
  delivery      TEXT NOT NULL DEFAULT 'sent'
);
CREATE INDEX IF NOT EXISTS idx_messages_agent_ts ON messages (agent_id, ts DESC);

CREATE TABLE IF NOT EXISTS turns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id       INTEGER NOT NULL,
  user_msg_id    INTEGER,
  trigger        TEXT NOT NULL DEFAULT 'reply',
  plan           TEXT,
  ctx_snapshot   TEXT,
  prompt         TEXT,
  model          TEXT,
  output         TEXT,
  first_token_ts INTEGER,
  delivered_ts   INTEGER,
  outcome        TEXT,
  created_ts     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS action_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT 'open_loop',
  payload     TEXT NOT NULL DEFAULT '{}',
  deadline_ts INTEGER NOT NULL,
  ttl_ms      INTEGER NOT NULL,
  epoch       INTEGER NOT NULL,
  state       TEXT NOT NULL DEFAULT 'queued',
  idem_key    TEXT NOT NULL,
  created_ts  INTEGER NOT NULL,
  UNIQUE (agent_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_action_queue_state ON action_queue (agent_id, state, deadline_ts);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id   INTEGER NOT NULL,
  actor_role      TEXT NOT NULL,
  action          TEXT NOT NULL,
  target_agent_id INTEGER,
  before          TEXT,
  after           TEXT,
  ts              INTEGER NOT NULL,
  ip_hash         TEXT,
  idem_key        TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cny      REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cost_ts ON cost_ledger (ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency (
  event_id   TEXT PRIMARY KEY,
  method     TEXT NOT NULL,
  result     TEXT NOT NULL,
  created_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS confirm_tokens (
  token     TEXT PRIMARY KEY,
  action    TEXT NOT NULL,
  target    TEXT,
  expires_ts INTEGER NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plugin_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  level     TEXT NOT NULL,
  message   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hazard_samples (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  features   TEXT NOT NULL,
  label_kind TEXT,
  label_ms   INTEGER,
  censored   INTEGER NOT NULL DEFAULT 1,
  policy     TEXT NOT NULL DEFAULT 'shadow',
  acted      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS exposures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        INTEGER NOT NULL,
  ts              INTEGER NOT NULL,
  bucket          TEXT NOT NULL,
  action          TEXT,
  propensity      REAL NOT NULL,
  resp_30m        INTEGER,
  negative_signal TEXT,
  d7_retained     INTEGER
);
`;
