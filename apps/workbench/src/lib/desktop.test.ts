import { afterEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

vi.mock('@tauri-apps/api/core', () => tauri);

import { initializeDesktop } from './desktop';

afterEach(() => {
  tauri.invoke.mockReset();
  tauri.isTauri.mockReset();
  tauri.isTauri.mockReturnValue(true);
  delete window.egeDesktop;
});

describe('desktop bridge', () => {
  it('passes a stable starting directory to the asynchronous native folder picker', async () => {
    tauri.invoke.mockImplementation(async (command: string, argumentsValue?: unknown) => {
      if (command === 'desktop_bootstrap') {
        return { apiOrigin: 'http://127.0.0.1:4317', platform: 'macos', appVersion: '0.1.0' };
      }
      if (command === 'select_workspace_directory') {
        expect(argumentsValue).toEqual({ initialDirectory: '/Users/example/Projects/orders' });
        return '/Users/example/Projects/orders-v2';
      }
      throw new Error(`Unexpected command ${command}`);
    });

    await initializeDesktop();
    await expect(window.egeDesktop?.selectWorkspaceDirectory('/Users/example/Projects/orders'))
      .resolves.toBe('/Users/example/Projects/orders-v2');
  });

  it('sends null when a new workspace has no previous directory and normalizes cancellation', async () => {
    tauri.invoke.mockImplementation(async (command: string, argumentsValue?: unknown) => {
      if (command === 'desktop_bootstrap') {
        return { apiOrigin: 'http://127.0.0.1:4317', platform: 'macos', appVersion: '0.1.0' };
      }
      if (command === 'select_workspace_directory') {
        expect(argumentsValue).toEqual({ initialDirectory: null });
        return null;
      }
      throw new Error(`Unexpected command ${command}`);
    });

    await initializeDesktop();
    await expect(window.egeDesktop?.selectWorkspaceDirectory()).resolves.toBeUndefined();
  });
});
