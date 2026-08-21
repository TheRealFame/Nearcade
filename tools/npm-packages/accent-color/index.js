const os = require('os');
const path = require('path');

const platform = os.platform();

function load() {
  try {
    return require(path.join(__dirname, 'lib', platform));
  } catch {
    return null;
  }
}

function get() {
  const mod = load();
  if (!mod) return null;
  return mod.get();
}

async function getAsync() {
  const mod = load();
  if (!mod || !mod.getAsync) return get();
  return mod.getAsync();
}

module.exports = { get, getAsync, load, platform };
