// Tiny shared helpers for the browser tests (no assertion lib dependency).

export const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed');
};

export const waitFor = async (cond, ms = 12000, step = 50) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
};

export function mount(dd, vnode) {
  const root = document.createElement('main');
  document.body.appendChild(root);
  dd.reconcile(root, [vnode]);
  return root;
}
