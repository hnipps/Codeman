/**
 * @fileoverview The canvas's two links to the Reviews page read `GET /api/reviews` through one parser.
 */
import { describe, expect, it } from 'vitest';
import { parseWaitingReviews, reviewWords, workReviewKey } from '../packages/canvas/src/reviews.js';

const row = (id: string, sessionId: string, state = 'ready') => ({ id, sessionId, state });

describe('parseWaitingReviews', () => {
  it('counts the waiting reviews and keys them by session', () => {
    const got = parseWaitingReviews({
      success: true,
      data: { waiting: [row('aaaaaaaaaaaaaaaa', 's1'), row('bbbbbbbbbbbbbbbb', 's2', 'updated')], done: [] },
    });
    expect(got?.count).toBe(2);
    expect(got?.bySession.get('s2')).toEqual({ id: 'bbbbbbbbbbbbbbbb', state: 'updated' });
  });

  it('links a session with two reviews to the first one listed', () => {
    const got = parseWaitingReviews({
      data: { waiting: [row('aaaaaaaaaaaaaaaa', 's1'), row('bbbbbbbbbbbbbbbb', 's1')] },
    });
    expect(got?.count).toBe(2);
    expect(got?.bySession.get('s1')?.id).toBe('aaaaaaaaaaaaaaaa');
  });

  it('does not count an approved review that is deploying, and still links its session to it', () => {
    const got = parseWaitingReviews({ data: { waiting: [row('aaaaaaaaaaaaaaaa', 's1', 'deploying')] } });
    expect(got?.count).toBe(0);
    expect(got?.bySession.get('s1')?.state).toBe('deploying');
  });

  it('keys a work review by its workspace and item, never by its stored session id', () => {
    const work = { ...row('dddddddddddddddd', 'work:ws-1:38'), work: { workspaceId: 'ws-1', key: 'W-38' } };
    const got = parseWaitingReviews({ data: { waiting: [work] } });
    expect(got?.count).toBe(1);
    expect(got?.byWork.get(workReviewKey('ws-1', 'W-38'))).toEqual({ id: 'dddddddddddddddd', state: 'ready' });
    expect(got?.byWork.get(workReviewKey('ws-2', 'W-38'))).toBeUndefined();
    expect(got?.bySession.size).toBe(0);
  });

  it('drops a row whose id could not be part of an address', () => {
    const got = parseWaitingReviews({
      data: { waiting: [row('../../api/x', 's1'), row('a/b', 's2'), null, 7, row('cccccccccccccccc', 's3')] },
    });
    expect(got?.count).toBe(1);
    expect([...(got?.bySession.keys() ?? [])]).toEqual(['s3']);
  });

  it('answers null for anything that is not the list', () => {
    for (const body of [null, undefined, 'x', {}, { data: {} }, { data: { waiting: 'no' } }, { success: false }])
      expect(parseWaitingReviews(body)).toBeNull();
  });
});

describe('reviewWords', () => {
  it('names the states a waiting review can be in, and falls back for one it does not know', () => {
    expect(reviewWords('ready')).toBe('Review ready for you');
    expect(reviewWords('deploy-failed')).toBe('Review approved, deploy failed');
    expect(reviewWords('something-new')).toBe('Review waiting');
  });
});
