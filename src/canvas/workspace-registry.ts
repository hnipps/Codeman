/** @fileoverview Stable workspace identity per owner and case, independent of its name. */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dataPath } from '../config/instance.js';
import { IdSchema } from './model.js';
import { atomicWrite, requireCanvasWriter } from './canvas-store.js';

const WorkspaceSchema = z.object({ id: IdSchema, caseName: z.string().min(1).max(256), owner: z.string().optional() });
const RegistrySchema = z.object({ version: z.literal(1), workspaces: z.array(WorkspaceSchema) });
export type Workspace = z.infer<typeof WorkspaceSchema>;
export function readWorkspaces(): Workspace[] {
  const path = dataPath('workspaces.json');
  return existsSync(path) ? RegistrySchema.parse(JSON.parse(readFileSync(path, 'utf8'))).workspaces : [];
}
export function workspaceForCase(caseName: string, owner?: string): Workspace {
  const workspaces = readWorkspaces();
  const existing = workspaces.find((w) => w.caseName === caseName && w.owner === owner);
  if (existing) return existing;
  requireCanvasWriter();
  const workspace = WorkspaceSchema.parse({ id: randomUUID(), caseName, ...(owner ? { owner } : {}) });
  atomicWrite(dataPath('workspaces.json'), { version: 1, workspaces: [...workspaces, workspace] });
  return workspace;
}
export function renameWorkspaceCase(from: string, to: string, owner?: string): void {
  const workspaces = readWorkspaces();
  const workspace = workspaces.find((w) => w.caseName === from && w.owner === owner);
  if (!workspace) return;
  if (workspaces.some((w) => w.caseName === to && w.owner === owner))
    throw new Error('Destination already has a canvas workspace');
  requireCanvasWriter();
  workspace.caseName = to;
  atomicWrite(dataPath('workspaces.json'), { version: 1, workspaces });
}
