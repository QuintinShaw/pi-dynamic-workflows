/**
 * Shared test doubles for the Pi ExtensionAPI surface that command-registration
 * code touches (getCommands / registerCommand) plus a notify-capturing command
 * context. Centralising these removes the copy-pasted `pi: any` mocks and the
 * per-test `as never` casts across the command test files.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface RegisteredCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => unknown;
}

export interface CommandRegistryPi {
  /** Typed as ExtensionAPI for call sites; backed by the in-memory registry. */
  pi: ExtensionAPI;
  /** Commands registered so far (most code registers, then we inspect/invoke). */
  commands: RegisteredCommand[];
  /** Messages delivered via pi.sendMessage, captured for assertions. */
  sent: Array<{ customType?: string; content?: string }>;
}

/**
 * A Pi mock that records registered commands and sent messages.
 *
 * @param existing - command names to pretend are already registered, so
 *   idempotency guards (isRegistered) can be exercised.
 */
export function makeCommandRegistryPi(existing: string[] = []): CommandRegistryPi {
  const commands: RegisteredCommand[] = [];
  const sent: Array<{ customType?: string; content?: string }> = [];
  const names = () => [...existing, ...commands.map((c) => c.name)];

  const pi = {
    getCommands: () => names().map((name) => ({ name })),
    registerCommand: (name: string, spec: Omit<RegisteredCommand, "name">) => {
      commands.push({ name, ...spec });
    },
    sendMessage: (msg: { customType?: string; content?: string }) => {
      sent.push(msg);
    },
  } as unknown as ExtensionAPI;

  return { pi, commands, sent };
}

export interface NotifyCtx {
  ctx: ExtensionCommandContext;
  notified: Array<{ message: string; type?: string }>;
}

/** A command context that captures ui.notify calls and no-ops the rest. */
export function makeNotifyCtx(mode?: "tui" | "rpc" | "json" | "print"): NotifyCtx {
  const notified: Array<{ message: string; type?: string }> = [];
  const ctx = {
    ...(mode ? { mode, hasUI: mode === "tui" || mode === "rpc" } : {}),
    ui: {
      notify: (message: string, type?: string) => notified.push({ message, type }),
      setStatus: () => {},
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notified };
}
