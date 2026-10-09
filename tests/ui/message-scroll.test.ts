// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { MessageScroll } from '../../src/ui/message-scroll';

describe('message scrolling', () => {
  it('follows new output, pauses while reading above, resumes at the bottom', () => {
    const element = document.createElement('div');
    Object.defineProperties(element, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 200 } });
    const scroll = new MessageScroll(element, () => true);
    scroll.update();
    expect(element.scrollTop).toBe(1000);
    element.scrollTop = 200;
    element.dispatchEvent(new Event('scroll'));
    scroll.update();
    expect(element.scrollTop).toBe(200);
    element.scrollTop = 800;
    element.dispatchEvent(new Event('scroll'));
    Object.defineProperty(element, 'scrollHeight', { value: 1200 });
    scroll.update();
    expect(element.scrollTop).toBe(1200);
    scroll.dispose();
  });
  it('does not scroll when disabled', () => {
    const element = document.createElement('div');
    Object.defineProperty(element, 'scrollHeight', { value: 1000 });
    const scroll = new MessageScroll(element, () => false);
    scroll.update();
    expect(element.scrollTop).toBe(0);
    scroll.dispose();
  });
  it('allows explicitly jumping to latest even with automatic scrolling disabled', () => {
    const element = document.createElement('div');
    Object.defineProperties(element, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
    let away = false;
    const scroll = new MessageScroll(element, () => false, value => { away = value; });
    scroll.update();
    expect(away).toBe(true);
    scroll.jumpToLatest();
    expect(element.scrollTop).toBe(1000);
    expect(away).toBe(false);
    scroll.dispose();
  });
});
