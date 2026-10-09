// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { PopoverDrag } from '../../src/ui/popover-drag';

afterEach(() => document.body.replaceChildren());
function pointer(target: EventTarget, type: string, x: number, y: number, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
}
function setup() {
  const modal = document.createElement('div');
  const handle = document.createElement('header');
  const button = document.createElement('button');
  const answer = document.createElement('p');
  handle.append(button); modal.append(handle, answer); document.body.append(modal);
  const size = { width: 400, height: 240 };
  modal.getBoundingClientRect = () => {
    const left = parseFloat(modal.style.left || '100'), top = parseFloat(modal.style.top || '80');
    return { left, top, right: left + size.width, bottom: top + size.height, ...size } as DOMRect;
  };
  handle.getBoundingClientRect = () => ({ bottom: modal.getBoundingClientRect().top + 70 }) as DOMRect;
  const drag = new PopoverDrag(modal, handle);
  return { modal, handle, button, answer, size, drag };
}

it('drags by the heading and retains the position after release', () => {
  const f = setup();
  try {
    pointer(f.handle, 'pointerdown', 120, 90);
    pointer(document, 'pointermove', 240, 190);
    expect(f.modal.style.left).toBe('220px');
    expect(f.modal.style.top).toBe('180px');
    expect(f.modal.style.getPropertyPriority('left')).toBe('important');
    pointer(document, 'pointerup', 240, 190);
    pointer(document, 'pointermove', 400, 400);
    expect(f.modal.style.left).toBe('220px');
  } finally { f.drag.dispose(); }
});

it('leaves controls, right clicks and answer selections alone', () => {
  const f = setup();
  try {
    for (const [target, button] of [[f.button, 0], [f.answer, 0], [f.handle, 2]] as const) {
      pointer(target, 'pointerdown', 120, 90, button);
      pointer(document, 'pointermove', 400, 400);
      expect(f.modal.style.left).toBe('');
    }
  } finally { f.drag.dispose(); }
});

it('includes the top and side heading padding but excludes the lower modal padding', () => {
  const f = setup();
  try {
    for (const [x, y] of [[300, 82], [102, 120]] as const) {
      f.modal.style.left = ''; f.modal.style.top = '';
      pointer(f.modal, 'pointermove', x, y);
      expect(f.modal.classList.contains('study-companion-quick-drag-hover')).toBe(true);
      pointer(f.modal, 'pointerdown', x, y);
      pointer(document, 'pointermove', x + 80, y + 60);
      pointer(document, 'pointerup', x + 80, y + 60);
      expect(f.modal.style.left).toBe('180px');
      expect(f.modal.style.top).toBe('140px');
    }
    pointer(f.modal, 'pointerdown', 200, 375);
    pointer(document, 'pointermove', 300, 400);
    expect(f.modal.style.left).toBe('180px');
  } finally { f.drag.dispose(); }
});

it('keeps the modal within its owner window after dragging, expanding and resizing', () => {
  const f = setup();
  try {
    pointer(f.handle, 'pointerdown', 120, 90);
    pointer(document, 'pointermove', 10000, 10000);
    expect(parseFloat(f.modal.style.left) + f.size.width).toBe(window.innerWidth - 12);
    expect(parseFloat(f.modal.style.top) + f.size.height).toBe(window.innerHeight - 12);
    pointer(document, 'pointercancel', 10000, 10000);
    f.size.width = 800; f.size.height = 600;
    window.dispatchEvent(new Event('resize'));
    expect(parseFloat(f.modal.style.left) + f.size.width).toBe(window.innerWidth - 12);
    expect(parseFloat(f.modal.style.top) + f.size.height).toBe(window.innerHeight - 12);
    pointer(f.handle, 'pointerdown', 220, 190);
    pointer(document, 'pointermove', -10000, -10000);
    expect(f.modal.style.left).toBe('12px');
    expect(f.modal.style.top).toBe('12px');
  } finally { f.drag.dispose(); }
});

it('releases document listeners on close even during a drag', () => {
  const f = setup();
  pointer(f.handle, 'pointerdown', 120, 90);
  f.drag.dispose();
  pointer(document, 'pointermove', 400, 400);
  expect(f.modal.style.left).toBe('');
});
