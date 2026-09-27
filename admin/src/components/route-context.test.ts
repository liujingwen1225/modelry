import { describe, expect, it } from 'vitest';
import { collectionIdFromPathname } from './route-context';

describe('Admin route context', () => {
  it('decodes a percent-encoded Collection ID', () => {
    expect(collectionIdFromPathname('/collections/col%20posts/schema')).toBe('col posts');
  });

  it('keeps a malformed encoded segment routable without throwing', () => {
    expect(collectionIdFromPathname('/collections/%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('does not treat the Create Collection route as a Collection detail', () => {
    expect(collectionIdFromPathname('/collections/new')).toBeUndefined();
    expect(collectionIdFromPathname('/collections/%6Eew')).toBeUndefined();
  });

  it('returns no Collection ID outside a Collection detail route', () => {
    expect(collectionIdFromPathname('/collections')).toBeUndefined();
    expect(collectionIdFromPathname('/settings')).toBeUndefined();
  });
});
