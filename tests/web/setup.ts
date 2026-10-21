/// <reference lib="dom" />
// jsdom lacks a few browser APIs that Svelte components use.

// `bind:clientHeight` observes size changes; jsdom has no layout, so nothing ever resizes.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// CodeMirror measures text ranges; jsdom has no layout, so every range is empty.
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getClientRects = empty;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

// The UI language is chosen once at startup (`web/src/lib/i18n`); the tests assert German texts.
try {
  localStorage.setItem('vw-language', 'de');
} catch {
  /* no storage: the tests below that need German then fail visibly */
}
