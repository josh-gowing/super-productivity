const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

require('ts-node/register/transpile-only');

const originalModuleLoad = Module._load;
const modulePath = path.resolve(__dirname, 'ipc-handler-wrapper.ts');

let userDataDir;

const installMocks = () => {
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath: (key) => {
            assert.equal(key, 'userData');
            return userDataDir;
          },
        },
      };
    }
    return originalModuleLoad.call(this, request, parent, isMain);
  };
};

const loadModule = () => {
  delete require.cache[modulePath];
  return require(modulePath);
};

test.beforeEach(() => {
  // A path with no trailing separator, so the sibling-prefix case is exercised.
  userDataDir = path.join(os.tmpdir(), 'sp-userdata');
  installMocks();
});

test.afterEach(() => {
  Module._load = originalModuleLoad;
  delete require.cache[modulePath];
});

test('validatePathInUserData() accepts the userData dir itself', () => {
  const { validatePathInUserData } = loadModule();
  assert.equal(validatePathInUserData(userDataDir), true);
});

test('validatePathInUserData() accepts a descendant path', () => {
  const { validatePathInUserData } = loadModule();
  assert.equal(
    validatePathInUserData(path.join(userDataDir, 'clipboard-images', 'a.png')),
    true,
  );
});

test('validatePathInUserData() rejects a ".." traversal that escapes userData', () => {
  const { validatePathInUserData } = loadModule();
  assert.equal(
    validatePathInUserData(path.join(userDataDir, '..', '..', 'etc', 'passwd')),
    false,
  );
  // The classic filename-traversal vector: a valid base + an escaping segment.
  assert.equal(
    validatePathInUserData(path.join(userDataDir, '../../../../etc/shadow')),
    false,
  );
});

test('validatePathInUserData() rejects a sibling dir sharing the prefix', () => {
  const { validatePathInUserData } = loadModule();
  // Bare startsWith() would wrongly accept this; the boundary check must not.
  assert.equal(validatePathInUserData(userDataDir + '-evil'), false);
  assert.equal(validatePathInUserData(userDataDir + '-evil/secret.txt'), false);
});

test('validatePathInUserData() rejects non-string and empty input', () => {
  const { validatePathInUserData } = loadModule();
  assert.equal(validatePathInUserData(''), false);
  assert.equal(validatePathInUserData(undefined), false);
  assert.equal(validatePathInUserData(null), false);
  assert.equal(validatePathInUserData(42), false);
  assert.equal(validatePathInUserData({ toString: () => userDataDir }), false);
});
