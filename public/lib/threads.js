// Which threads this app may talk into, and where tapping one goes.
//
// The rule is ownership, and it is a correctness rule rather than a policy
// one. Event fan-out is per-session-transport: the gateway addresses events to
// whichever transport last touched a session, with no subscribe and no
// broadcast. Two consequences, both verified by spiking against a live
// backend and recorded in docs/DESIGN-NOTES.md:
//
//   * Telegram and cron sessions belong to the separate hermes-gateway
//     process. Calling session.resume on one from here cold-loads its history
//     and builds a SECOND agent against the same transcript.
//   * Attaching to a session another transport holds silently redirects its
//     events -- so resuming a web-pwa (desktop dashboard) chat would leave the
//     desktop's own UI mute.
//
// So: we resume only the sessions this app created. Everything else opens
// read-only, which is what the transcript view already was.

/** The DB `source` stamped on sessions this app opens (see chat.js). */
export const OWN_SOURCE = 'hermes-mobile';

export const isOwnThread = (session) => session?.source === OWN_SOURCE;

/** Chattable threads open in the composer; the rest open read-only. */
export function threadHref(session) {
  const id = encodeURIComponent(session.id);
  return isOwnThread(session) ? `#/chat/${id}` : `#/session/${id}`;
}

// ------------------------------------------------------- Telegram hand-off --
//
// The read-only rule above leaves a real question unanswered: you are looking
// at a Telegram conversation and you want to reply to it. The answer is not to
// weaken the rule, it is that the Telegram client is already on this phone. So
// hand off.
//
// Session rows carry the gateway's view of the chat -- `chat_id`, `chat_type`
// and `thread_id`, the same pair that `channel_directory.json` joins into
// `<chat_id>:<thread_id>`. Whether that is enough to name a destination depends
// entirely on the kind of chat:
//
//   * Supergroups and channels have ids of the form -100<internal>, and
//     `t.me/c/<internal>[/<thread>]` is the link Telegram itself produces for
//     them. It resolves for any member, and the thread segment selects the
//     forum topic. Derivable, so we link.
//   * Direct messages do not work at all. The Bot API reports a private chat's
//     id as the *user's* id, so `chat_id` here names the person holding the
//     phone rather than the bot they were talking to; a link built from it
//     opens their own profile. Addressing the bot instead needs its username,
//     which appears nowhere this app can read -- `/api/messaging/platforms` is
//     not on the proxy's read allowlist and the env routes are withheld on
//     purpose. Telegram's own deep-link reference is blunt about the numeric
//     escape hatch: `tg://user?id=` is "merely an abstraction offered by the
//     bot API ... and should be ignored by normal clients". So we return null
//     and the control simply is not there. A link to the wrong chat would be
//     worse than the omission, and inventing a backend route to fetch the bot
//     username would put a new hole in an allowlist built one line at a time.
//
// https rather than tg://. Both open the app when it is installed, but t.me is
// a Universal Link Telegram claims, so on iOS it opens the app directly and
// falls back to a web page otherwise -- where a tg:// href from a home-screen
// PWA dead-ends in a scheme prompt.

const digits = (value) => (/^\d+$/.test(String(value ?? '')) ? String(value) : null);

/**
 * The phone's own Telegram client, pointed at this thread -- or null when the
 * session does not name a chat we can address truthfully. Callers must treat
 * null as "omit the control", never as "link to Telegram generally".
 */
export function telegramHref(session) {
  if (session?.source !== 'telegram') return null;

  // Only the -100 space is linkable, and it is never a direct message, so the
  // prefix carries the whole decision without trusting chat_type.
  const internal = /^-100(\d+)$/.exec(String(session.chat_id ?? ''))?.[1];
  if (!internal) return null;

  const thread = digits(session.thread_id);
  return `https://t.me/c/${internal}${thread ? `/${thread}` : ''}`;
}
