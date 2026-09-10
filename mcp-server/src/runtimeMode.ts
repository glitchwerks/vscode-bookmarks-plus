import { resolveWorkspaceState, type Config } from './config.js';
import { LiveBridgeStartupError, type LiveBridgeConfig } from './liveBridgeClient.js';

export type RuntimeMode =
  | { kind: 'live'; config: LiveBridgeConfig }
  | { kind: 'mirror'; config: Config }
  | { kind: 'disabled'; reason: string };

/** Selects live mode before consulting any standalone workspace configuration. */
export function resolveRuntimeMode(argv: readonly string[], env: NodeJS.ProcessEnv): RuntimeMode {
  const values = [
    env.BOOKMARKS_PLUS_LIVE_MODE, env.BOOKMARKS_PLUS_ROOT_URI,
    env.BOOKMARKS_PLUS_BRIDGE_ENDPOINT, env.BOOKMARKS_PLUS_BRIDGE_PROTOCOL,
    env.BOOKMARKS_PLUS_BRIDGE_GENERATION, env.BOOKMARKS_PLUS_BRIDGE_TOKEN,
  ];
  if (values.every((value) => value === undefined)) {
    const state = resolveWorkspaceState([...argv], env);
    return state.kind === 'ok' ? { kind: 'mirror', config: state.config } : state;
  }

  const [marker, root, endpoint, protocol, generation, token] = values;
  if (values.some((value) => value === undefined || value.trim().length === 0) ||
      marker !== '1' || protocol !== '1' || !isAbsoluteRootUri(root!)) {
    throw new LiveBridgeStartupError('bridge-unavailable', 'The live bridge configuration is unavailable.');
  }
  return {
    kind: 'live', config: {
      endpoint: endpoint!, protocolVersion: 1, generation: generation!, token: token!,
      workspaceFolderUri: root!,
    },
  };
}

/** Root identities are absolute hierarchical URIs, including remote workspace schemes. */
function isAbsoluteRootUri(value: string): boolean {
  try {
    const uri = new URL(value);
    decodeURI(value);
    return /^[a-z][a-z\d+.-]*:\/\//i.test(value) && uri.pathname.startsWith('/') &&
      !/\s/.test(value) && uri.search === '' && uri.hash === '';
  } catch {
    return false;
  }
}
