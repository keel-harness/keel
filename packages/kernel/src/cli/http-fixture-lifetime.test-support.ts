export interface HttpFixtureServer {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections(): void;
}

/** Force-closes one HTTP(S) test fixture and settles after its listener and connections are gone.
 *  Stop acceptance before taking the established-connection snapshot: reversing these calls leaves
 *  a race where a newly accepted socket can make `close()` wait forever. */
export function closeHttpFixture(server: HttpFixtureServer): Promise<void> {
  return new Promise<void>((resolveClose, reject) => {
    let forceCloseReturned = false;
    let closeOutcome: Error | null | undefined;
    const settle = (): void => {
      if (!forceCloseReturned || closeOutcome === undefined) return;
      if (closeOutcome === null) resolveClose();
      else reject(closeOutcome);
    };
    server.close((error) => {
      closeOutcome = error ?? null;
      settle();
    });
    server.closeAllConnections();
    forceCloseReturned = true;
    settle();
  });
}
