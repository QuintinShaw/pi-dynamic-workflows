/**
 * User-level settings for pi-dynamic-workflows.
 *
 * Stored separately from Pi's own settings.json so extension preferences remain
 * stable without depending on host-internal config shape.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { WORKFLOW_SETTINGS_FILE } from "./config.js";

export interface WorkflowSettings {
  keywordTriggerEnabled?: boolean;
}

/** Path to the user-level workflow settings JSON file (~/.pi/workflows/settings.json). */
export function getWorkflowSettingsPath(): string {
  return join(homedir(), WORKFLOW_SETTINGS_FILE);
}

/** Load settings from disk. Missing, corrupt, or invalid files resolve to {}. */
export function loadWorkflowSettings(settingsPath?: string): WorkflowSettings {
  const path = settingsPath ?? getWorkflowSettingsPath();
  if (!existsSync(path)) return {};
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return {};
  }
}

/** Merge known settings into the user-level settings file. */
export function saveWorkflowSettings(settings: WorkflowSettings, settingsPath?: string): void {
  const path = settingsPath ?? getWorkflowSettingsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existing = readObject(path);
  writeFileSync(path, `${JSON.stringify({ ...existing, ...normalizeSettings(settings) }, null, 2)}\n`, "utf-8");
}

function normalizeSettings(value: unknown): WorkflowSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return typeof raw.keywordTriggerEnabled === "boolean" ? { keywordTriggerEnabled: raw.keywordTriggerEnabled } : {};
}

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
