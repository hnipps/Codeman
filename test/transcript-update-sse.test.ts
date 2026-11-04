import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { SseEvent } from '../src/web/sse-events.js';

vi.mock('../src/transcript-watcher.js', () => ({
  TranscriptWatcher: class extends EventEmitter {
    updatePath = vi.fn();
  },
}));

describe('transcript snapshot invalidation SSE', () => {
  it('wires one content-free notification per watcher update, including after path replacement', () => {
    const server = Object.create(WebServer.prototype);
    Object.assign(server, { transcriptWatchers: new Map(), broadcast: vi.fn() });
    server.startTranscriptWatcher('session-1', 'transcript.jsonl');
    const watcher = server.transcriptWatchers.get('session-1');
    server.startTranscriptWatcher('session-1', 'replacement.jsonl');
    watcher.emit('transcript:update', { messages: ['private transcript text'] });
    expect(watcher.listenerCount('transcript:update')).toBe(1);
    expect(server.broadcast).toHaveBeenCalledExactlyOnceWith(SseEvent.TranscriptUpdate, {
      sessionId: 'session-1',
      timestamp: expect.any(Number),
    });
  });
});
