import { createWorktree, removeWorktree, type WorktreeOperations } from "../../src/index.js";

export const exportedOperations: WorktreeOperations = {
  createWorktree,
  removeWorktree,
};
