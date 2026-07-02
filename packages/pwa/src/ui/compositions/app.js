// Root composition. Injects the engine, subscribes to the TetherQuery via bones
// `watch`, and translates component CustomEvents into ngin Action dispatches.
// This is the only place that touches the engine — components stay pure.

import { dd, watch, fromQuery } from '../../runtime.js';
import {
  TetherQuery,
  SendTextAction,
  AttachFilesAction,
  RemoveAttachmentAction,
  ToggleConversationAction,
  CancelVoicePrepAction,
  ToggleListeningAction,
  StopSpeakingAction,
  SpeakMessageAction,
  InterruptAgentAction,
  ManualStartAction,
  ManualStopAction,
  OpenSettingsAction,
  CloseSettingsAction,
  SetSettingAction,
  ListSessionsAction,
  ConnectSessionAction,
  NewSessionAction,
  CloseSessionsAction,
  AnswerAskAction,
  SubmitFormAction,
  CancelFormAction,
  OpenTethersAction,
  CloseTethersAction,
  OpenDetailsAction,
  CloseDetailsAction,
  OpenShortcutsAction,
  CloseShortcutsAction,
  SwitchTetherAction,
  AddTetherAction,
  RemoveTetherAction,
} from '../../bl/tether.js';
import voicePrep from '../components/voicePrep.js';
import statusBar from '../components/statusBar.js';
import messageList from '../components/messageList.js';
import micMeter from '../components/micMeter.js';
import controlBar from '../components/controlBar.js';
import settingsSheet from '../components/settingsSheet.js';
import sessionsSheet from '../components/sessionsSheet.js';
import tethersSheet from '../components/tethersSheet.js';
import detailsSheet from '../components/detailsSheet.js';
import shortcutsSheet from '../components/shortcutsSheet.js';
import formSheet from '../components/formSheet.js';
import askPrompt from '../components/askPrompt.js';

const { alias, div, p, strong } = dd;

export default function app(engine) {
  // One stable query instance for the app's lifetime.
  const tether$ = fromQuery(engine.query(new TetherQuery()));
  const go = (action) => engine.dispatch(action);

  const handlers = {
    'send-text': (e) => go(new SendTextAction(e.detail)),
    'attach-files': (e) => go(new AttachFilesAction(e.detail.files)),
    'remove-attachment': (e) => go(new RemoveAttachmentAction(e.detail.id)),
    'toggle-conversation': () => go(new ToggleConversationAction()),
    'cancel-voice-prep': () => go(new CancelVoicePrepAction()),
    'toggle-listening': () => go(new ToggleListeningAction()),
    'stop-speaking': () => go(new StopSpeakingAction()),
    'speak-message': (e) => go(new SpeakMessageAction(e.detail.text)),
    interrupt: () => go(new InterruptAgentAction()),
    'ptt-down': () => go(new ManualStartAction()),
    'ptt-up': () => go(new ManualStopAction()),
    'open-settings': () => go(new OpenSettingsAction()),
    close: () => go(new CloseSettingsAction()),
    set: (e) => go(new SetSettingAction(e.detail.key, e.detail.value)),
    'open-sessions': () => go(new ListSessionsAction()),
    'connect-session': (e) => go(new ConnectSessionAction(e.detail.id)),
    'new-session': () => go(new NewSessionAction()),
    'close-sessions': () => go(new CloseSessionsAction()),
    'answer-ask': (e) => go(new AnswerAskAction(e.detail.answer)),
    'submit-form': (e) => go(new SubmitFormAction(e.detail)),
    'cancel-form': (e) => go(new CancelFormAction(e.detail.id)),
    'open-tethers': () => go(new OpenTethersAction()),
    'close-tethers': () => go(new CloseTethersAction()),
    'open-details': () => go(new OpenDetailsAction()),
    'close-details': () => go(new CloseDetailsAction()),
    'open-shortcuts': () => { go(new CloseSettingsAction()); go(new OpenShortcutsAction()); },
    'close-shortcuts': () => go(new CloseShortcutsAction()),
    'switch-tether': (e) => go(new SwitchTetherAction(e.detail.id)),
    'add-tether': (e) => go(new AddTetherAction(e.detail)),
    'remove-tether': (e) => go(new RemoveTetherAction(e.detail.id)),
  };

  return alias(() => div({ className: 'shell' }, watch(tether$, view)).on(handlers));
}

function view(state) {
  if (!state) return div({ className: 'screen' }, p({ className: 'hint' }, 'starting…'));

  const showHero = state.connection !== 'tethered' && state.messages.length === 0;

  return div({ className: 'screen' },
    statusBar(state),
    state.toast && div({ className: `banner ${state.toast.level || 'info'}` }, state.toast.text),
    showHero ? hero(state) : messageList(state),
    state.statusLine && div({ className: 'status-line' }, state.statusLine),
    state.ask && askPrompt(state.ask),
    micMeter(state),
    controlBar(state),
    state.error && div({ className: 'banner error' }, state.error),
    state.sheetOpen && settingsSheet(state),
    state.sessionsOpen && sessionsSheet(state),
    state.tethersOpen && tethersSheet(state),
    state.detailsOpen && detailsSheet(state),
    state.shortcutsOpen && shortcutsSheet(state),
    state.form && formSheet(state),
    state.preparingVoice && voicePrep(state),
  );
}

function hero(state) {
  if (state.connection === 'no-tether') {
    return div({ className: 'hero' },
      p({ className: 'hero-title' }, '🐴 bridle'),
      p(['Scan the QR from ', strong('bridle'), ' on your desktop — or add it in ', strong('Tethers'), '.']),
      p({ className: 'hint' }, 'Already paired? Open Tethers to pick a desktop.'),
    );
  }
  return div({ className: 'hero' },
    p({ className: 'hero-title' }, '🐴 bridle'),
    p(state.connection === 'waiting'
      ? ['Connected to the relay. ', strong('Start bridle on your desktop'), ' to link.']
      : 'Linking to your desktop…'),
    p({ className: 'hint' }, 'Tip: tap the mic to go hands-free and just talk. Say "stop talking" to cut in.'),
  );
}
