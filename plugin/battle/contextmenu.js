const NATIVE_MENU = 'input, textarea, [data-pkb-native-menu="allow"]';

const NOT_TYPED = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);

const PRESS_REST = ['pointerdown', 'pointerup', 'mouseup', 'auxclick'];

const CAPTURE = { capture: true };

function inTextField(event) {
  const target = event.composedPath?.().find(node => typeof node?.closest === 'function') ?? event.target;
  const element = typeof target?.closest === 'function' ? target : target?.parentElement;
  if (!element || element.isContentEditable) return true;
  const field = element.closest(NATIVE_MENU);
  return !!field && !(field.localName === 'input' && NOT_TYPED.has(String(field.type ?? '').toLowerCase()));
}

const backs = [];

export function pushBack(root, back) {
  const entry = { root, back };
  backs.push(entry);
  if (root?.ownerDocument?.addEventListener) guardContextMenu(root.ownerDocument);
  return () => {
    const at = backs.indexOf(entry);
    if (at >= 0) backs.splice(at, 1);
  };
}

export function goBack() {
  for (let i = backs.length - 1; i >= 0; i--) {
    const { root, back } = backs[i];
    if (root?.isConnected === false || root?.hidden) continue;
    try { back(); } catch (error) { console.error(error); }
    return true;
  }
  return false;
}

const guarded = new WeakSet();

export function guardContextMenu(root) {
  if (!root?.addEventListener || guarded.has(root)) return () => {};
  guarded.add(root);
  const right = event => event.button === 2 && !inTextField(event);
  const handlers = {
    contextmenu: event => { if (!inTextField(event)) event.preventDefault(); },
    mousedown: event => {
      if (!right(event)) return;
      event.stopPropagation(); event.preventDefault();
      goBack();
    },
    ...Object.fromEntries(PRESS_REST.map(type => [type, event => { if (right(event)) event.stopPropagation(); }])),
  };
  for (const [type, fn] of Object.entries(handlers)) root.addEventListener(type, fn, CAPTURE);
  return () => {
    guarded.delete(root);
    for (const [type, fn] of Object.entries(handlers)) root.removeEventListener(type, fn, CAPTURE);
  };
}
