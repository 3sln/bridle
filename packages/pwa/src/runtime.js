// Wire up the 3sln stack for the browser:
//   - dodo: the default VDOM instance (named exports h, reconcile, element helpers…)
//   - dodo/reactive: the Cell protocol + the `watch` component bound to that instance
//
// `fromQuery` bridges an ngin Query subscription into a dodo Cell so we can
// `watch(...)` a Query directly in compositions — that's the seam between
// business logic (ngin) and reactive UI (dodo).

import * as dodo from '@3sln/dodo';
import { watch, fromObservable, PENDING } from '@3sln/dodo/reactive';

export const dd = dodo;

export { watch, PENDING };

/**
 * Adapt an ngin query handle ({ subscribe, peek }) to a dodo Cell.
 * `watch(fromQuery(engine.query(q)), value => vnode)` renders reactively.
 *
 * The cell is `connectable`: it subscribes on the first watcher and
 * unsubscribes on the last, so detaching the watch kills the query. Until the
 * query's first `notify` the cell reads PENDING, and `watch` renders its
 * placeholder rather than calling the builder with no state.
 */
export function fromQuery(handle) {
  return fromObservable(handle);
}
