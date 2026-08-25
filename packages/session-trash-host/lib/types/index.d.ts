/**
 * Session Trash Host plugin: patches SessionPersistence, SessionProjectionCache,
 * and WorkspaceRegistry with delete, unarchive, permanent-delete, and listing
 * capabilities. Registers new Typert RPC methods for the browser surface.
 * @module @deepseek-ai/dsh-session-trash-host
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Patched services available after this plugin's init. */
    sessionTrashHost?: SessionTrashHost;
  }
}

/** One row projected from the archive set for a recycle-bin surface. */
export interface ArchivedSessionView {
  sessionId: SessionId;
  title: string;
  cwd?: string;
  workspacePath?: string;
  workspaceTitle?: string;
}

export declare class SessionTrashHost {
  static inject: string[];
  constructor(ctx: Context);
  protected [Service.init](): Promise<void>;
}

export default SessionTrashHost;