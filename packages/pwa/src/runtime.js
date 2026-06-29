// Wire up the 3sln stack for the browser:
//   - dodo: the default VDOM instance (named exports h, reconcile, element helpers…)
//   - bones: reactive "batteries", built from the dodo instance via its factory
//
// `fromQuery` bridges an ngin Query subscription into a bones Observable so we
// can `watch(...)` a Query directly in compositions — that's the seam between
// business logic (ngin) and reactive UI (dodo+bones).

import * as dodo from '@3sln/dodo';
import reactiveFactory from '@3sln/bones/reactive.js';

export const dd = dodo;

export const reactive = reactiveFactory({ dodo });
export const { watch, ObservableSubject, Observable, pipe, map, dedup } = reactive;

/**
 * Adapt an ngin query handle ({ subscribe, peek }) to a bones Observable.
 * `watch(fromQuery(engine.query(q)), value => vnode)` renders reactively.
 */
export function fromQuery(handle) {
  return new Observable((observer) => {
    const sub = handle.subscribe(observer);
    return { unsubscribe: () => sub.unsubscribe() };
  });
}
