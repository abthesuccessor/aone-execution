export class RequestControllers {
  private readonly controllers = new Map<string, AbortController>();

  start(requestId: string): AbortController | null {
    if (this.controllers.has(requestId)) return null;
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    return controller;
  }

  owns(requestId: string, controller: AbortController): boolean {
    return this.controllers.get(requestId) === controller && !controller.signal.aborted;
  }

  runIfOwned(requestId: string, controller: AbortController, callback: () => void): void {
    if (this.owns(requestId, controller)) callback();
  }

  finish(requestId: string, controller: AbortController): void {
    if (this.owns(requestId, controller)) this.controllers.delete(requestId);
  }

  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}
