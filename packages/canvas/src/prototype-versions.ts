/**
 * @fileoverview Who published each stored prototype version and when, read from `GET .../prototypes`, for the
 * phone card's line and the review bar ("v3 · Agent 1a2b3c4d"). Names come from the server's record of the
 * publisher: they are shown with `textContent` only.
 */
import { z } from 'zod';
import { authorName, type ViewAuthor } from './comments.js';

const AuthorSchema = z.union([
  z.object({ kind: z.literal('human'), userId: z.string() }).passthrough(),
  z.object({ kind: z.literal('agent'), sessionId: z.string() }).passthrough(),
]);
const ListSchema = z.object({
  success: z.literal(true),
  data: z.object({
    prototypes: z.array(
      z
        .object({
          id: z.string(),
          versions: z.array(
            z.object({ version: z.number(), createdAt: z.number(), author: AuthorSchema }).passthrough()
          ),
        })
        .passthrough()
    ),
  }),
});

export type VersionInfo = { createdAt: number; author: string };

/** Each stored version by `<prototype id>/<version>`. An answer that is not the list gives none. */
export function parseVersionInfo(data: unknown): Map<string, VersionInfo> {
  const parsed = ListSchema.safeParse(data);
  const info = new Map<string, VersionInfo>();
  if (!parsed.success) return info;
  for (const p of parsed.data.data.prototypes)
    for (const v of p.versions)
      info.set(`${p.id}/${v.version}`, { createdAt: v.createdAt, author: authorName(v.author as ViewAuthor).name });
  return info;
}

const REFRESH_MS = 400;

export class PrototypeVersions {
  private info = new Map<string, VersionInfo>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loaded = false;

  constructor(
    private host: {
      url: (path: string) => string;
      workspace: string;
      /** The list was read again. */
      changed: () => void;
    }
  ) {}

  get(prototypeId: string, version: number): VersionInfo | null {
    return this.info.get(`${prototypeId}/${version}`) ?? null;
  }
  /** Whether the list has been read at least once, so a version it lacks is one the server no longer stores. */
  get ready(): boolean {
    return this.loaded;
  }
  /** The canvas changed (a publish writes an operation): read the list again, once per burst. */
  refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.load(), REFRESH_MS);
  }
  private async load(): Promise<void> {
    try {
      const response = await fetch(this.host.url(`/api/canvas/${this.host.workspace}/prototypes`));
      if (!response.ok) return;
      this.info = parseVersionInfo(await response.json());
      this.loaded = true;
      this.host.changed();
    } catch {
      /* Offline: the versions already read stay, and the next change reads again. */
    }
  }
}
