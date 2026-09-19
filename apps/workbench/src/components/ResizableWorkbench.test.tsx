import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizableWorkbench, WORKBENCH_LAYOUT_STORAGE_KEY } from './ResizableWorkbench';

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

function renderWorkbench(width = 1_400, height = 800) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect(this: HTMLElement) {
    const isWorkbench = this.classList?.contains('workbench-main');
    return {
      width: isWorkbench ? width : 0,
      height: isWorkbench ? height : 0,
      top: 0,
      left: 0,
      right: isWorkbench ? width : 0,
      bottom: isWorkbench ? height : 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  });

  const result = render(
    <ResizableWorkbench>
      <aside>Node Library</aside>
      <section>Graph canvas</section>
      <aside>Node Context</aside>
      <section>Plan and Execution</section>
    </ResizableWorkbench>,
  );
  return { ...result, root: result.container.querySelector('.workbench-main') as HTMLElement };
}

function storedSizes() {
  return JSON.parse(window.localStorage.getItem(WORKBENCH_LAYOUT_STORAGE_KEY) ?? '{}') as {
    version?: number;
    sizes?: { left: number; right: number; bottom: number };
  };
}

describe('ResizableWorkbench', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    window.localStorage.clear();
  });

  it('restores a versioned layout and exposes fully keyboard-operable separators', async () => {
    window.localStorage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 1,
      sizes: { left: 240, right: 340, bottom: 280 },
    }));
    renderWorkbench();

    const libraryHandle = screen.getByRole('separator', { name: 'Resize node library' });
    const contextHandle = screen.getByRole('separator', { name: 'Resize node context' });
    const bottomHandle = screen.getByRole('separator', { name: 'Resize plan, execution, and trace panel' });

    expect(libraryHandle).toHaveAttribute('aria-orientation', 'vertical');
    expect(libraryHandle).toHaveAttribute('aria-valuemin', '150');
    expect(libraryHandle).toHaveAttribute('aria-valuenow', '240');
    expect(libraryHandle).toHaveAttribute('aria-valuetext', '240 pixels');
    expect(contextHandle).toHaveAttribute('aria-orientation', 'vertical');
    expect(bottomHandle).toHaveAttribute('aria-orientation', 'horizontal');
    for (const handle of [libraryHandle, contextHandle, bottomHandle]) {
      const controlledIds = handle.getAttribute('aria-controls')?.split(' ') ?? [];
      expect(controlledIds.length).toBeGreaterThan(0);
      controlledIds.forEach((id) => expect(document.getElementById(id)).not.toBeNull());
    }

    fireEvent.keyDown(libraryHandle, { key: 'ArrowRight' });
    expect(libraryHandle).toHaveAttribute('aria-valuenow', '248');
    fireEvent.keyDown(libraryHandle, { key: 'ArrowRight', shiftKey: true });
    expect(libraryHandle).toHaveAttribute('aria-valuenow', '280');
    fireEvent.keyDown(libraryHandle, { key: 'Home' });
    expect(libraryHandle).toHaveAttribute('aria-valuenow', '150');
    fireEvent.keyDown(libraryHandle, { key: 'End' });
    expect(libraryHandle).toHaveAttribute('aria-valuenow', '420');

    fireEvent.keyDown(contextHandle, { key: 'ArrowLeft' });
    expect(contextHandle).toHaveAttribute('aria-valuenow', '348');
    fireEvent.keyDown(bottomHandle, { key: 'ArrowUp' });
    expect(bottomHandle).toHaveAttribute('aria-valuenow', '288');
    fireEvent.keyDown(bottomHandle, { key: 'End' });
    expect(bottomHandle).toHaveAttribute('aria-valuenow', '520');

    await waitFor(() => expect(storedSizes()).toEqual({
      version: 1,
      sizes: { left: 420, right: 348, bottom: 520 },
    }));
  });

  it('resizes by pointer, persists on release, and cleans up on pointer cancellation', async () => {
    const { root } = renderWorkbench();
    const contextHandle = screen.getByRole('separator', { name: 'Resize node context' });
    const bottomHandle = screen.getByRole('separator', { name: 'Resize plan, execution, and trace panel' });

    Object.defineProperties(contextHandle, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });

    fireEvent.pointerDown(contextHandle, { pointerId: 7, clientX: 1_000 });
    expect(contextHandle.setPointerCapture).toHaveBeenCalledWith(7);
    expect(root).toHaveClass('is-resizing-right');
    expect(document.body.style.userSelect).toBe('none');
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 940 });
    expect(root.style.getPropertyValue('--right-panel-width')).toBe('378px');
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 940 });
    expect(contextHandle).toHaveAttribute('aria-valuenow', '378');
    expect(contextHandle.releasePointerCapture).toHaveBeenCalledWith(7);

    fireEvent.pointerDown(bottomHandle, { pointerId: 8, clientY: 500 });
    fireEvent.pointerMove(window, { pointerId: 8, clientY: 430 });
    expect(root.style.getPropertyValue('--bottom-panel-height')).toBe('380px');
    fireEvent.pointerCancel(window, { pointerId: 8, clientY: 430 });
    expect(bottomHandle).toHaveAttribute('aria-valuenow', '380');
    expect(root).not.toHaveClass('is-resizing');
    expect(document.body.style.userSelect).toBe('');

    await waitFor(() => expect(storedSizes()).toEqual({
      version: 1,
      sizes: { left: 190, right: 378, bottom: 380 },
    }));
  });

  it('validates stored values and clamps them after measuring the available canvas', async () => {
    window.localStorage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 1,
      sizes: { left: 999, right: 999, bottom: 999 },
    }));
    renderWorkbench(1_000, 500);

    const libraryHandle = screen.getByRole('separator', { name: 'Resize node library' });
    const contextHandle = screen.getByRole('separator', { name: 'Resize node context' });
    const bottomHandle = screen.getByRole('separator', { name: 'Resize plan, execution, and trace panel' });

    await waitFor(() => {
      expect(libraryHandle).toHaveAttribute('aria-valuenow', '150');
      expect(contextHandle).toHaveAttribute('aria-valuenow', '434');
      expect(bottomHandle).toHaveAttribute('aria-valuenow', '272');
    });
    expect(libraryHandle).toHaveAttribute('aria-valuemax', '150');
    expect(contextHandle).toHaveAttribute('aria-valuemax', '434');
    expect(bottomHandle).toHaveAttribute('aria-valuemax', '272');
    expect(storedSizes()).toEqual({
      version: 1,
      sizes: { left: 150, right: 434, bottom: 272 },
    });
  });
});
