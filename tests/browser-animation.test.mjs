import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { patchBrowserAnimationSource } from '../scripts/patch-browser-animation.mjs';

const project = resolve(import.meta.dirname, '..');
const upstream = resolve(process.env.YSMVIEWER_SOURCE || resolve(project, '.vendor/ysmviewer'));
const webroot = resolve(upstream, 'YSMViewer.Browser/wwwroot');
// A missing pinned checkout is a failure, not a skipped playback check.
const original = readFileSync(resolve(webroot, 'ysm-three-renderer.js'), 'utf8');
const THREE = await import(pathToFileURL(resolve(webroot, 'three.module.min.js')).href);
const candidate = process.env.YSM_TEST_UNPATCHED === '1'
  ? original : patchBrowserAnimationSource(original);

function createHarness(source) {
  let now = 0;
  let nextFrame = 0;
  const frames = new Map();
  const diagnostics = [];
  const context = vm.createContext({
    THREE,
    performance: { now: () => now },
    requestAnimationFrame(callback) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    console: {
      log() {},
      warn: (...args) => diagnostics.push(args),
      error: (...args) => diagnostics.push(args),
    },
  });
  // Execute the actual renderer functions. Only the module wrapper is removed;
  // the real bundled Three.js mixer, keyframe tracks and bindings are retained.
  const executable = source
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^export /gm, '');
  vm.runInContext(executable + `
    scene = new THREE.Scene();
    globalThis.api = {
      loadModelGeometry, loadAnimationData, playAnimation, stopAnimation,
      clearScene, getAnimationProgress,
      bone: id => boneGroups.get(id),
    };
  `, context, { filename: 'ysm-three-renderer.js' });
  return {
    ...context.api,
    diagnostics,
    advance(milliseconds) {
      // Exercise the production RAF loop and its 100 ms delta cap.
      for (let remaining = milliseconds; remaining > 0;) {
        const delta = Math.min(remaining, 100);
        remaining -= delta;
        now += delta;
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(now);
      }
    },
    progress() { return JSON.parse(context.api.getAnimationProgress()); },
  };
}

const baseRotation = [0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)];
function modelSpec(position = [2, 3, 4]) {
  return {
    models: [
      { id: 'decoy', bones: [
        { id: 'decoy-bone', name: 'joint.arm[0]/한글', localPosition: [9, 8, 7] },
      ] },
      { id: 'character', bones: [
        { id: 'root', name: 'root', localPosition: [0, 0, 0] },
        { id: 'parent', name: 'parent', parentId: 'root', localPosition: [0, 1, 0] },
        { id: 'animated-bone', name: 'joint.arm[0]/한글', parentId: 'parent',
          localPosition: position, localRotation: baseRotation },
      ] },
    ],
  };
}

const animations = { animations: {
  move: { animation_length: 1, bones: { 'animated-bone': {
    rotation: { '0.0': [0, 0, 0], '1.0': [0, 0, 90] },
    position: { '0.0': [0, 0, 0], '1.0': [16, 32, -16] },
    scale: { '0.0': [1, 1, 1], '1.0': [2, 3, 4] },
  } } },
  other: { animation_length: 1, bones: { 'animated-bone': {
    position: { '0.0': [0, 0, 0], '1.0': [-32, 0, 0] },
  } } },
} };

function load(harness, position) {
  harness.loadModelGeometry(JSON.stringify(modelSpec(position)));
  harness.loadAnimationData(JSON.stringify(animations));
}

function closeTo(actual, expected, message) {
  assert.equal(actual.length, expected.length, message);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Number.isFinite(actual[i]) && Math.abs(actual[i] - expected[i]) < 1e-6,
      `${message}[${i}]: expected ${expected[i]}, got ${actual[i]}`);
  }
}

function captureThreeDiagnostics(callback) {
  const messages = [];
  const saved = { warn: console.warn, error: console.error };
  console.warn = (...args) => messages.push(args);
  console.error = (...args) => messages.push(args);
  try { callback(messages); }
  finally { console.warn = saved.warn; console.error = saved.error; }
  return messages;
}

test('nested duplicate-named bones move in position, rotation and scale through the real RAF/mixer path', () => {
  const harness = createHarness(candidate);
  const messages = captureThreeDiagnostics(() => {
    load(harness);
    harness.playAnimation('move');
    harness.advance(500);
  });
  const bone = harness.bone('animated-bone');
  closeTo(bone.position.toArray(), [1.5, 4, 3.5], 'animated position');
  closeTo(bone.scale.toArray(), [1.5, 2, 2.5], 'animated scale');
  const sy = Math.sin(Math.PI / 12), cy = Math.cos(Math.PI / 12);
  const sz = Math.sin(Math.PI / 8), cz = Math.cos(Math.PI / 8);
  closeTo(bone.quaternion.toArray(), [sy * sz, sy * cz, cy * sz, cy * cz], 'animated rotation');
  closeTo(harness.bone('decoy-bone').position.toArray(), [9, 8, 7], 'same-name decoy');
  assert.equal(harness.progress().time, 0.5);
  assert.equal(harness.progress().duration, 1);
  assert.deepEqual(messages, []);
  assert.deepEqual(harness.diagnostics, []);
});

test('switching, stopping and clearing animations restore the pose and do not animate a stale model', () => {
  const harness = createHarness(candidate);
  const messages = captureThreeDiagnostics(() => {
    load(harness);
    harness.playAnimation('move');
    harness.advance(300);
    harness.playAnimation('other');
    harness.advance(500);
    const bone = harness.bone('animated-bone');
    closeTo(bone.position.toArray(), [3, 3, 4], 'second animation');
    closeTo(bone.quaternion.toArray(), baseRotation, 'rotation restored on switch');
    closeTo(bone.scale.toArray(), [1, 1, 1], 'scale restored on switch');
    harness.stopAnimation();
    harness.advance(500);
    closeTo(bone.position.toArray(), [2, 3, 4], 'stopped position');
    closeTo(bone.quaternion.toArray(), baseRotation, 'stopped rotation');
    closeTo(bone.scale.toArray(), [1, 1, 1], 'stopped scale');
    assert.deepEqual(harness.progress(), { time: 0, duration: 0 });
    harness.clearScene();
    load(harness, [5, 6, 7]);
    harness.playAnimation('move');
    harness.advance(500);
    closeTo(harness.bone('animated-bone').position.toArray(), [4.5, 7, 6.5], 'new model');
    closeTo(bone.position.toArray(), [2, 3, 4], 'old model remains stopped');
  });
  assert.deepEqual(messages, []);
  assert.deepEqual(harness.diagnostics, []);
});

test('unpatched upstream is a negative control: time advances, bones remain still and binding fails', () => {
  const harness = createHarness(original);
  const messages = captureThreeDiagnostics(() => {
    load(harness);
    harness.playAnimation('move');
    harness.advance(500);
  });
  assert.equal(harness.progress().time, 0.5);
  closeTo(harness.bone('animated-bone').position.toArray(), [2, 3, 4], 'unpatched frozen pose');
  assert.ok(messages.some(args => String(args[0]).includes('THREE.PropertyBinding')));
});

test('the source patch accepts LF/CRLF and rejects stale or already-patched upstream', () => {
  const patched = patchBrowserAnimationSource(original);
  assert.throws(() => patchBrowserAnimationSource(patched), /changed/);
  assert.throws(() => patchBrowserAnimationSource(original.replace('getObjectPath(scene, boneObj)', 'differentPath(scene, boneObj)')), /changed/);
  const crlf = original.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
  assert.equal(patchBrowserAnimationSource(crlf).replaceAll('\r\n', '\n'), patched.replaceAll('\r\n', '\n'));
});
