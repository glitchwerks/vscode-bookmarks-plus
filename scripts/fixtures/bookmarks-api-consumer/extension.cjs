'use strict';

const vscode = require('vscode');
const PRODUCER_ID = 'cbeaulieu-gt.vscode-bookmarks-plus';

/** Return a bounded, secret-free optional-integration outcome. */
function fallback(reason) {
  return Object.freeze({ kind: 'fallback', reason });
}

/** Discover and negotiate solely through the producer's activation export. */
async function connect(workspaceFolderUri) {
  if (!vscode.workspace.isTrusted) return fallback('workspace-untrusted');
  const extension = vscode.extensions.getExtension(PRODUCER_ID);
  if (!extension) return fallback('missing-extension');
  try {
    const api = await extension.activate();
    const capability = api?.capabilities?.mcpConnection;
    if (
      api?.apiVersion?.major !== 1 ||
      !Array.isArray(capability?.descriptorVersions) ||
      !capability.descriptorVersions.includes(1) ||
      !Array.isArray(capability?.transports) ||
      !capability.transports.includes('stdio') ||
      !Array.isArray(capability?.scopes) ||
      !capability.scopes.includes('workspace') ||
      !capability.scopes.includes('global')
    ) {
      return fallback('incompatible-api');
    }
    const result = await api.requestMcpConnection({
      workspaceFolderUri,
      scopes: ['workspace', 'global'],
      supportedDescriptorVersions: [1],
    });
    return result.kind === 'success'
      ? Object.freeze({ kind: 'descriptor', descriptor: result.descriptor })
      : fallback(result.error.code);
  } catch {
    return fallback('activation-or-request-rejected');
  }
}

/** Activate independently of whether Bookmarks Plus is installed or enabled. */
function activate() {
  return Object.freeze({ connect });
}

module.exports = { activate };
