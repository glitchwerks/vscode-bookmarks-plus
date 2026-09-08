import * as vscode from 'vscode';

/** A workspace root paired with its stable caller-provided identifier. */
export interface RootCandidate {
  readonly id: string;
  readonly label: string;
  readonly uri: vscode.Uri;
}

/** A root candidate that structurally contains a URI. */
export interface RootMatch extends RootCandidate {
  readonly canonicalUri: string;
}

/** The result of rebasing a URI from one root onto another. */
export interface RebaseResult {
  readonly kind: 'rebased' | 'outside-old-root' | 'incompatible-uri';
  readonly uri?: vscode.Uri;
}

/** Raised when a URI cannot safely identify a workspace root. */
export class InvalidRootUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRootUriError';
  }
}

interface ComparableUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly segments: readonly string[];
}

/** Removes trailing separators without changing root or interior path components. */
function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed || '/';
}

/** Returns the structural components used for URI identity and containment. */
function comparable(uri: vscode.Uri): ComparableUri {
  // VS Code serializes file drive letters in lowercase; keep persisted identities round-trip safe.
  const uriPath = uri.scheme.toLowerCase() === 'file'
    ? uri.path.replace(/^\/[A-Z]:(?=\/|$)/, drive => drive.toLowerCase())
    : uri.path;
  // VS Code components are already decoded. A literal %61 directory must never become "a".
  const path = trimTrailingSeparators(uriPath);
  return {
    scheme: uri.scheme.toLowerCase(),
    authority: uri.authority.toLowerCase(),
    path,
    segments: path === '/' ? [] : path.slice(1).split('/')
  };
}

/** Throws when a URI cannot be used as a canonical workspace-root identity. */
function assertValidRootUri(uri: vscode.Uri): void {
  if (!uri.scheme || (uri.path !== '' && !uri.path.startsWith('/'))) {
    throw new InvalidRootUriError('A workspace root URI must be absolute.');
  }
  if (uri.query) {
    throw new InvalidRootUriError('A workspace root URI cannot include a query.');
  }
  if (uri.fragment) {
    throw new InvalidRootUriError('A workspace root URI cannot include a fragment.');
  }
}

/** True when `prefix` contains each leading structural path component in `value`. */
function isSegmentPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((segment, index) => segment === value[index]);
}

/** Reconstructs a normalized absolute URI path from structural segments. */
function pathFromSegments(segments: readonly string[]): string {
  return `/${segments.join('/')}`;
}

/**
 * Returns the stable identity of an absolute root URI. Schemes and authorities are
 * case-insensitive; decoded path segments preserve literal names and are safely serialized.
 */
export function canonicalizeRootUri(uri: vscode.Uri): string {
  assertValidRootUri(uri);
  const value = comparable(uri);
  let path = value.path.split('/').map(encodeURIComponent).join('/');
  // Preserve the established canonical file-drive spelling without unescaping other colons.
  if (value.scheme === 'file') path = path.replace(/^\/([a-z])%3A(?=\/|$)/, '/$1:');
  return `${value.scheme}://${value.authority}${path}`;
}

/** Returns whether `uri` is the root itself or lies below it on a path-component boundary. */
export function isUriInsideRoot(uri: vscode.Uri, root: vscode.Uri): boolean {
  assertValidRootUri(root);
  const uriValue = comparable(uri);
  const rootValue = comparable(root);
  return uriValue.scheme === rootValue.scheme
    && uriValue.authority === rootValue.authority
    && isSegmentPrefix(rootValue.segments, uriValue.segments);
}

/** Finds the deepest root structurally containing `uri`, independent of root-list order. */
export function findDeepestRoot(uri: vscode.Uri, roots: readonly RootCandidate[]): RootMatch | undefined {
  const deepestMatches: RootMatch[] = [];
  let deepestLength = -1;

  for (const root of roots) {
    if (!isUriInsideRoot(uri, root.uri)) {
      continue;
    }

    const length = comparable(root.uri).segments.length;
    if (length > deepestLength) {
      deepestLength = length;
      deepestMatches.splice(0, deepestMatches.length, {
        ...root,
        canonicalUri: canonicalizeRootUri(root.uri)
      });
    } else if (length === deepestLength) {
      deepestMatches.push({ ...root, canonicalUri: canonicalizeRootUri(root.uri) });
    }
  }

  return deepestMatches.length === 1 ? deepestMatches[0] : undefined;
}

/** Groups only the root identities supplied more than once. */
export function findCanonicalRootCollisions(
  roots: readonly RootCandidate[]
): ReadonlyMap<string, readonly RootCandidate[]> {
  const groups = new Map<string, RootCandidate[]>();

  for (const root of roots) {
    const canonicalUri = canonicalizeRootUri(root.uri);
    const group = groups.get(canonicalUri);
    if (group) {
      group.push(root);
    } else {
      groups.set(canonicalUri, [root]);
    }
  }

  for (const [canonicalUri, group] of groups) {
    if (group.length === 1) {
      groups.delete(canonicalUri);
    }
  }

  return groups;
}

/**
 * Relocates a URI inside `oldRoot` to the equivalent relative path under `newRoot`.
 * Roots and item must share scheme and authority; incompatible or outside URIs are unchanged.
 */
export function rebaseUri(uri: vscode.Uri, oldRoot: vscode.Uri, newRoot: vscode.Uri): RebaseResult {
  assertValidRootUri(oldRoot);
  assertValidRootUri(newRoot);
  const uriValue = comparable(uri);
  const oldRootValue = comparable(oldRoot);
  const newRootValue = comparable(newRoot);

  if (oldRootValue.scheme !== newRootValue.scheme || oldRootValue.authority !== newRootValue.authority
    || uriValue.scheme !== oldRootValue.scheme || uriValue.authority !== oldRootValue.authority) {
    return { kind: 'incompatible-uri' };
  }
  if (!isSegmentPrefix(oldRootValue.segments, uriValue.segments)) {
    return { kind: 'outside-old-root' };
  }

  const relativeSegments = uriValue.segments.slice(oldRootValue.segments.length);
  return {
    kind: 'rebased',
    uri: vscode.Uri.from({
      scheme: newRoot.scheme,
      authority: newRoot.authority,
      path: pathFromSegments([...newRootValue.segments, ...relativeSegments]),
      query: uri.query,
      fragment: uri.fragment
    })
  };
}

/** Converts VS Code workspace folders into stable root candidates. */
export function toRootCandidates(
  folders: readonly vscode.WorkspaceFolder[] | undefined
): readonly RootCandidate[] {
  return (folders ?? []).map((folder, index) => ({
    id: `${index}:${folder.uri.toString(true)}`,
    label: folder.name,
    uri: folder.uri
  }));
}
