// Settings sheet. Emits `set` {key,value} and `close`. Pure dodo.
import { dd } from '../../runtime.js';
import { icon } from '../icon.js';

const { alias, div, label, span, input, select, option, button } = dd;

export default alias(function (state) {
  const self = this;
  const s = state.settings || {};
  const set = (key, value) => self.dispatchEvent(new CustomEvent('set', { bubbles: true, detail: { key, value } }));
  const close = () => self.dispatchEvent(new CustomEvent('close', { bubbles: true }));

  const toggle = (key, text) =>
    label({ className: 'row' },
      span(text),
      input({ type: 'checkbox', checked: !!s[key] }).on({ change: (e) => set(key, e.target.checked) }),
    );

  const slider = (key, text, min, max, step) =>
    label({ className: 'row' },
      span(text),
      span({ className: 'val' }, String(s[key])),
      input({ type: 'range', min, max, step, value: s[key] }).on({ input: (e) => set(key, Number(e.target.value)) }),
    );

  const voicePicker = label({ className: 'row' },
    span('Voice'),
    select(
      { value: s.ttsVoice || '' },
      option({ value: '' }, 'Default'),
      (state.voices || []).map((name) => option({ value: name }, name).key(name)),
    ).on({ change: (e) => set('ttsVoice', e.target.value) }),
  );

  const leadIn = label({ className: 'row' },
    span('Command word'),
    input({ type: 'text', value: s.commandLeadIn || '', className: 'lead-in' }).on({
      change: (e) => set('commandLeadIn', e.target.value.trim()),
    }),
  );

  return div({ className: 'sheet-backdrop' },
    div({ className: 'sheet' },
      div({ className: 'sheet-head' }, span('Settings'), button({ className: 'btn ghost' }, 'Done').on({ click: close })),
      toggle('drivingMode', 'Driving mode (hands-free)'),
      toggle('autoSpeak', 'Read replies aloud'),
      toggle('conversationOnConnect', 'Start hands-free voice on connect'),
      toggle('earcons', 'Audio cues (earcons)'),
      toggle('keepAwake', 'Keep screen awake'),
      toggle('mediaControls', 'Headset / car buttons'),
      slider('ttsRate', 'Speech rate', 0.5, 2.5, 0.05),
      voicePicker,
      slider('vadThreshold', 'Mic sensitivity', 0.004, 0.05, 0.002),
      slider('vadHangoverMs', 'Silence to send (ms)', 400, 2000, 50),
      leadIn,
      button({ className: 'btn ghost row-btn desktop-only' }, icon('keyboard'), 'Keyboard shortcuts')
        .on({ click: () => self.dispatchEvent(new CustomEvent('open-shortcuts', { bubbles: true })) }),
      div({ className: 'hint' }, `Say "${s.commandLeadIn || 'bridle'} pause", "${s.commandLeadIn || 'bridle'} repeat", or just "stop talking".`),
    ),
  ).on({
    // Click on the backdrop (not the sheet) closes.
    click: (e) => { if (e.target.classList.contains('sheet-backdrop')) close(); },
  });
});
