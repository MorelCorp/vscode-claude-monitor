import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { quoteForShell } from '../src/bridge';
import { encodeProjectDir } from '../src/paths';

test('quoteForShell survives spaces and quotes', () => {
  assert.equal(quoteForShell('/home/a b/bridge.sh'), `'/home/a b/bridge.sh'`);
  assert.equal(quoteForShell("/home/o'brien/bridge.sh"), `'/home/o'\\''brien/bridge.sh'`);
});

test('encodeProjectDir matches how Claude Code names project directories', () => {
  assert.equal(encodeProjectDir('/home/user/vscode-claude-monitor'), '-home-user-vscode-claude-monitor');
  assert.equal(encodeProjectDir('/a.b/c_d'), '-a-b-c-d');
});
