import '@testing-library/jest-dom/vitest';
import React from 'react';
import { vi } from 'vitest';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, 'ResizeObserver', { value: ResizeObserverMock, configurable: true });
Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: vi.fn(() => false) },
  setPointerCapture: { configurable: true, value: vi.fn() },
  releasePointerCapture: { configurable: true, value: vi.fn() },
  scrollIntoView: { configurable: true, value: vi.fn() },
});
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock('../lib/monaco', () => ({}));

vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  default: ({ value }: { value?: string }) => React.createElement('pre', { 'data-testid': 'code-editor' }, value),
  DiffEditor: ({ original, modified }: { original?: string; modified?: string }) => React.createElement(
    'div',
    { 'data-testid': 'diff-editor' },
    React.createElement('pre', null, original),
    React.createElement('pre', null, modified),
  ),
}));
