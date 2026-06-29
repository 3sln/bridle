// Root composition. Injects the engine, subscribes to the TetherQuery via bones
// `watch`, and translates component CustomEvents into ngin Action dispatches.
// This is the only place that touches the engine — components stay pure.

import { dd, watch, fromQuery } from '../../runtime.js';
import {
  TetherQuery,
  SendTextAction,
  ToggleConversationAction,
  ToggleListeningAction,
  StopSpeakingAction,
  InterruptAgentAction,
  ManualStartAction,
  ManualStopAction,
  OpenSettingsAction,
  CloseSettingsAction,
  SetSettingAction,
} from '../../bl/tether.js';
import statusBar from '../components/statusBar.js';
import messageList from '../components/messageList.js';
import micMeter from '../components/micMeter.js';
import controlBar from '../components/controlBar.js';
import settingsSheet from '../components/settingsSheet.js';

const { alias, div, p, strong } = dd;

export default function app(engine) {
  // One stable query instance for the app's lifetime.
  const tether$ = fromQuery(engine.query(new TetherQuery()));
  const go = (action) => engine.dispatch(action);

  const handlers = {
    'send-text': (e) => go(new SendTextAction(e.detail)),
    'toggle-conversation': () => go(new ToggleConversationAction()),
    'toggle-listening': () => go(new ToggleListeningAction()),
    'stop-speaking': () => go(new StopSpeakingAction()),
    interrupt: () => go(new InterruptAgentAction()),
    'ptt-down': () => go(new ManualStartAction()),
    'ptt-up': () => go(new ManualStopAction()),
    'open-settings': () => go(new OpenSettingsAction()),
    close: () => go(new CloseSettingsAction()),
    set: (e) => go(new SetSettingAction(e.detail.key, e.detail.value)),
  };

  return alias(() => div({ className: 'shell' }, watch(tether$, view)).on(handlers));
}

function view(state) {
  if (!state) return div({ className: 'screen' }, p({ className: 'hint' }, 'starting…'));

  const showHero = state.connection !== 'tethered' && state.messages.length === 0;

  return div({ className: 'screen' },
    statusBar(state),
    showHero ? hero(state) : messageList(state.messages),
    micMeter(state),
    controlBar(state),
    state.sttState === 'loading' && div({ className: 'banner' }, `loading speech model… ${state.sttProgress || 0}%`),
    state.error && div({ className: 'banner error' }, state.error),
    state.sheetOpen && settingsSheet(state),
  );
}

function hero(state) {
  return div({ className: 'hero' },
    p({ className: 'hero-title' }, '🐴 bridle'),
    p(state.connection === 'waiting'
      ? ['Connected to the relay. ', strong('Start bridle on your desktop'), ' to link.']
      : 'Linking to your desktop…'),
    p({ className: 'hint' }, 'Tip: turn on conversation mode and just talk. Say "stop talking" to cut in.'),
  );
}
