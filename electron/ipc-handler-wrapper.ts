import { app } from 'electron';
import * as path from 'path';

/**
 * Validates that the given path resolves to the userData directory or a
 * descendant of it. Treats the argument as untrusted IPC input.
 *
 * Boundary-aware: a bare `startsWith(userData)` would also accept a sibling
 * directory like `${userData}-evil`, so we require an exact match or a path
 * separator boundary. `path.resolve` already collapses `..` segments, so
 * traversal out of userData resolves to a non-prefixed path and is rejected.
 */
export const validatePathInUserData = (targetPath: unknown): boolean => {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return false;
  }
  const userDataPath = path.resolve(app.getPath('userData'));
  const resolved = path.resolve(targetPath);
  return resolved === userDataPath || resolved.startsWith(userDataPath + path.sep);
};

/**
 * Creates a validated IPC handler with consistent error handling and optional path validation.
 */
export const createValidatedHandler = <TArgs extends object, TResult>(
  handler: (args: TArgs) => Promise<TResult>,
  options?: {
    validatePath?: boolean;
    errorValue?: TResult;
  },
): ((event: Electron.IpcMainInvokeEvent, args: TArgs) => Promise<TResult>) => {
  return async (_, args: TArgs) => {
    try {
      // Add path validation if requested
      if (options?.validatePath && 'basePath' in args) {
        const basePath = (args as any).basePath;
        if (!validatePathInUserData(basePath)) {
          throw new Error('Invalid base path');
        }
      }

      return await handler(args);
    } catch (error) {
      console.error(`IPC handler error:`, error);
      if (options?.errorValue !== undefined) {
        return options.errorValue;
      }
      throw error;
    }
  };
};
