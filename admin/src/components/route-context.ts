export function collectionIdFromPathname(pathname: string): string | undefined {
  const match = pathname.match(/^\/collections\/([^/]+)/);
  if (!match?.[1]) return undefined;

  let id: string;
  try { id = decodeURIComponent(match[1]); }
  catch { id = match[1]; }
  return id === 'new' ? undefined : id;
}
