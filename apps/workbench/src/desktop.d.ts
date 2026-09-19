export {};

declare global {
  interface Window {
    egeDesktop?: {
      platform: string;
      appVersion: string;
      selectWorkspaceDirectory: (initialDirectory?: string) => Promise<string | undefined>;
    };
  }
}
