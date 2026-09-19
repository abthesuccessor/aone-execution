import { invoke, isTauri } from '@tauri-apps/api/core';
import { configureApiOrigin } from './api';

interface DesktopBootstrap {
  apiOrigin: string;
  platform: string;
  appVersion: string;
}

export async function initializeDesktop(): Promise<void> {
  if (!isTauri()) {
    configureApiOrigin();
    return;
  }

  const bootstrap = await invoke<DesktopBootstrap>('desktop_bootstrap');
  configureApiOrigin(bootstrap.apiOrigin);
  window.egeDesktop = Object.freeze({
    platform: bootstrap.platform,
    appVersion: bootstrap.appVersion,
    async selectWorkspaceDirectory(initialDirectory?: string) {
      const path = await invoke<string | null>('select_workspace_directory', {
        initialDirectory: initialDirectory ?? null,
      });
      return path ?? undefined;
    },
  });
}
