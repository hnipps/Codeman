/**
 * @fileoverview The address an `embed` object carries when its page is a prototype Codeman stores and
 * serves itself.
 *
 * A prototype is an ordinary `embed` in the operation log, so the previous release still reads the
 * workspace after a rollback (it shows the embed as unavailable). The address names the prototype and
 * one immutable published version, so publishing a new version is a plain content update: undo returns
 * to the earlier version, and the browser loads a fresh frame because the address changed.
 *
 * `.invalid` is reserved (RFC 2606) and never resolves, so the address can never reach the network.
 */
export const PROTOTYPE_HOST = 'prototype.invalid';
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENTRY = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.html?$/;

export interface PrototypeAddress {
  id: string;
  version: number;
  /** The HTML file the frame opens, relative to the version's root. */
  entry: string;
}

export const isPrototypeId = (id: string): boolean => ID.test(id);
export const isPrototypeEntry = (entry: string): boolean =>
  entry.length <= 256 && ENTRY.test(entry) && !entry.split('/').some((part) => part.startsWith('.'));

export function prototypeAddress(address: PrototypeAddress): string {
  return `https://${PROTOTYPE_HOST}/${address.id}/${address.version}/${address.entry}`;
}

export function parsePrototypeAddress(url: string): PrototypeAddress | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== PROTOTYPE_HOST || parsed.search || parsed.hash) return null;
  const [id, version, ...rest] = parsed.pathname.slice(1).split('/');
  const entry = rest.join('/');
  if (!id || !ID.test(id) || !version || !/^[1-9][0-9]{0,8}$/.test(version) || !isPrototypeEntry(entry)) return null;
  return { id, version: Number(version), entry };
}
