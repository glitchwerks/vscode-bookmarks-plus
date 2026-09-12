'use strict';

/** Advertise an unsupported major without granting credentials or spawning MCP. */
function activate() {
  return Object.freeze({
    apiVersion: Object.freeze({ major: 2, minor: 0 }),
    capabilities: Object.freeze({}),
  });
}

module.exports = { activate };
