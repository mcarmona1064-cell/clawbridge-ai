/**
 * Channel capability model.
 *
 * Every feature that shapes a message (choices, edits, progress updates,
 * file delivery, formatting, splitting) asks this model what a channel can
 * do instead of branching on the channel's name. Adapters declare their own
 * `capabilities`; `capabilitiesFor()` falls back to the defaults below for
 * adapters that have not declared any (skill-installed channels, older
 * Chat SDK bridges).
 */

/** How the channel renders formatted text. */
export type FormatDialect = 'markdown' | 'slack' | 'telegram-html' | 'whatsapp' | 'discord' | 'plain';

export interface ChoiceCapabilities {
  /** Max inline buttons in one message (0 = no buttons). */
  buttons: number;
  /** Max rows in a pick-list/menu (0 = no lists). */
  list: number;
  /** Max characters in a button or list-row label. */
  labelMax: number;
}

export interface ChannelCapabilities {
  /** Conversations are threads (one thread = one session). */
  threads: boolean;
  choices: ChoiceCapabilities;
  /** The bot can edit a message it sent. */
  edit: boolean;
  /** The bot can react to a message. */
  reactions: boolean;
  /** A typing/"working" indicator exists. */
  typing: boolean;
  /** The bot can send files. */
  filesOut: boolean;
  /** Voice notes arrive and are transcribed. */
  voiceIn: boolean;
  /** Longest text the platform accepts in one message. */
  maxText: number;
  format: FormatDialect;
  /** Native slash or bot commands appear in the client's menu. */
  commands: boolean;
  /** A per-user home screen exists (Slack App Home, Telegram menu). */
  home: boolean;
  /** The bot can open a DM with a user who never wrote to it. */
  openDM: boolean;
  /**
   * Hours after the user's last message during which free-form replies are
   * allowed. Outside the window only pre-approved templates may be sent.
   * `null` = no window (send any time).
   */
  replyWindowHours: number | null;
}

const NO_CHOICES: ChoiceCapabilities = { buttons: 0, list: 0, labelMax: 0 };

/** Conservative baseline: plain text, numbered replies for choices. */
export const PLAIN_CAPABILITIES: ChannelCapabilities = {
  threads: false,
  choices: NO_CHOICES,
  edit: false,
  reactions: false,
  typing: false,
  filesOut: false,
  voiceIn: false,
  maxText: 4000,
  format: 'plain',
  commands: false,
  home: false,
  openDM: false,
  replyWindowHours: null,
};

export const DEFAULT_CAPABILITIES: Record<string, ChannelCapabilities> = {
  slack: {
    threads: true,
    choices: { buttons: 25, list: 100, labelMax: 75 },
    edit: true,
    reactions: true,
    typing: true,
    filesOut: true,
    voiceIn: true,
    maxText: 11_000,
    format: 'slack',
    commands: true,
    home: true,
    openDM: true,
    replyWindowHours: null,
  },
  telegram: {
    threads: false,
    // Inline keyboards allow up to 100 buttons; callback_data is 64 bytes.
    choices: { buttons: 24, list: 0, labelMax: 64 },
    edit: true,
    reactions: true,
    typing: true,
    filesOut: true,
    voiceIn: true,
    maxText: 4096,
    format: 'telegram-html',
    commands: true,
    home: true,
    openDM: false,
    replyWindowHours: null,
  },
  whatsapp: {
    threads: false,
    // Reply buttons: max 3, 20-char titles. List messages: max 10 rows, 24 chars.
    choices: { buttons: 3, list: 10, labelMax: 20 },
    edit: false,
    reactions: true,
    typing: true,
    filesOut: true,
    voiceIn: true,
    maxText: 4096,
    format: 'whatsapp',
    commands: false,
    home: false,
    openDM: false,
    // Meta's customer-service window: free-form messages only within 24h of
    // the user's last message; templates otherwise.
    replyWindowHours: 24,
  },
  discord: {
    threads: true,
    // 5 action rows × 5 buttons; labels up to 80 chars.
    choices: { buttons: 25, list: 25, labelMax: 80 },
    edit: true,
    reactions: true,
    typing: true,
    filesOut: true,
    voiceIn: true,
    maxText: 2000,
    format: 'discord',
    commands: true,
    home: false,
    openDM: true,
    replyWindowHours: null,
  },
  cli: { ...PLAIN_CAPABILITIES, maxText: 100_000, format: 'markdown' },
  // Chat SDK bridge channels: the SDK renders Markdown and cards per platform.
  teams: {
    ...PLAIN_CAPABILITIES,
    threads: true,
    choices: { buttons: 6, list: 0, labelMax: 40 },
    edit: true,
    reactions: true,
    typing: true,
    filesOut: true,
    maxText: 25_000,
    format: 'markdown',
    openDM: true,
  },
  gchat: {
    ...PLAIN_CAPABILITIES,
    threads: true,
    choices: { buttons: 6, list: 0, labelMax: 40 },
    edit: true,
    typing: false,
    filesOut: true,
    maxText: 4_000,
    format: 'markdown',
    openDM: true,
  },
  webex: {
    ...PLAIN_CAPABILITIES,
    threads: true,
    choices: { buttons: 5, list: 0, labelMax: 40 },
    edit: true,
    filesOut: true,
    maxText: 7_000,
    format: 'markdown',
    openDM: true,
  },
  matrix: {
    ...PLAIN_CAPABILITIES,
    edit: true,
    reactions: true,
    typing: true,
    filesOut: true,
    maxText: 30_000,
    format: 'markdown',
  },
  signal: {
    ...PLAIN_CAPABILITIES,
    edit: true,
    reactions: true,
    typing: true,
    filesOut: true,
    voiceIn: true,
    maxText: 2_000,
  },
  imessage: { ...PLAIN_CAPABILITIES, filesOut: true, maxText: 10_000 },
  email: { ...PLAIN_CAPABILITIES, filesOut: true, maxText: 100_000, format: 'markdown' },
};

/** Look up a channel's capabilities: adapter-declared, then defaults, then plain. */
export function capabilitiesFor(
  channelType: string,
  declared?: Partial<ChannelCapabilities> | null,
): ChannelCapabilities {
  const base = DEFAULT_CAPABILITIES[channelType] ?? PLAIN_CAPABILITIES;
  if (!declared) return base;
  return { ...base, ...declared, choices: { ...base.choices, ...(declared.choices ?? {}) } };
}

export type ChoiceLayout = 'buttons' | 'list' | 'numbered';

/**
 * Pick how to present `count` options on this channel: inline buttons when
 * they fit, else a pick-list, else a numbered list the user answers by
 * replying with a number.
 */
export function planChoices(caps: ChannelCapabilities, count: number): ChoiceLayout {
  if (count > 0 && count <= caps.choices.buttons) return 'buttons';
  if (count > 0 && count <= caps.choices.list) return 'list';
  return 'numbered';
}
