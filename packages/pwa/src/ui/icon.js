// Material Symbols glyph. The icon font is self-hosted and precached by the
// service worker (see public/fonts/README.md), so a glyph is always available —
// including offline, which is where bridle is most often used. `.msym` boxes the
// span to 1em so even a failed font load can't spill the ligature name across
// the layout.
//
// Adding a glyph means regenerating the font subset — the recipe is in that
// README, and the list below is the source of truth for what's in it.
import { dd } from '../runtime.js';

const { span } = dd;

/** Every glyph in the shipped subset. Keep in sync when adding an icon. */
export const GLYPHS = [
  'add', 'add_comment', 'add_photo_alternate', 'arrow_upward', 'bolt', 'call_end',
  'check', 'close', 'description', 'dns', 'done_all', 'forum', 'graphic_eq',
  'keyboard', 'lan', 'mic', 'mic_off', 'pause', 'play_arrow', 'schedule',
  'settings', 'skip_next', 'smart_toy', 'swap_horiz', 'sync', 'verified_user',
  'volume_off', 'volume_up', 'vpn_key',
];

export const icon = (name, className = '') =>
  span({ className: `msym ${className}`.trim(), 'aria-hidden': 'true' }, name);
