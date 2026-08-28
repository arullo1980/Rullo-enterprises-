/**
 * Bridge from the CommonJS main process to the ES modules in shared/.
 *
 * The shared code has to run unchanged in three places — this process, the
 * renderer, and a Cloudflare Worker — so it is written as plain ES modules and
 * loaded here with a dynamic import rather than being duplicated.
 */

const path = require("node:path");
const { pathToFileURL } = require("node:url");

let cached = null;

async function shared() {
  if (cached) return cached;
  const load = (file) => import(pathToFileURL(path.join(__dirname, "..", "shared", file)).href);
  const [platforms, providers, adapters] = await Promise.all([
    load("platforms.js"), load("providers.js"), load("adapters.js"),
  ]);
  cached = { platforms, providers, adapters };
  return cached;
}

module.exports = { shared };
