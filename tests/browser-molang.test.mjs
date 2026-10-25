import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { patchBrowserAnimationSource } from '../scripts/patch-browser-animation.mjs';

const upstream = resolve(process.env.YSMVIEWER_SOURCE || '.vendor/ysmviewer');
const webroot = resolve(upstream, 'YSMViewer.Browser/wwwroot');
const original = readFileSync(resolve(webroot, 'ysm-three-renderer.js'), 'utf8');
const THREE = await import(pathToFileURL(resolve(webroot, 'three.module.min.js')).href);
// The previous deployed fix is the negative control for this separate defect.
const bindingOnly = original.replace(
  'const bonePath = getObjectPath(scene, boneObj);', 'const bonePath = boneObj.uuid;');
const candidate = process.env.YSM_TEST_BINDING_ONLY === '1' ? bindingOnly : patchBrowserAnimationSource(original);

function harness(source = candidate) {
  let now = 0, frameId = 0, expressions = [];
  const frames = new Map(), diagnostics = [], calls = [];
  const contextValues = { yaw: 0 };
  const sandbox = vm.createContext({
    THREE, performance: { now: () => now },
    requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; },
    console: { log() {}, warn: (...args) => diagnostics.push(args), error: (...args) => diagnostics.push(args) },
    ysmConfigureMolang(json) {
      if (contextValues.bridgeFault === 'configure') throw new Error('Deliberate bridge failure');
      expressions = JSON.parse(json);
    },
    // This checks the JS/managed bridge contract. The .NET tests and browser
    // smoke test separately execute the actual upstream MoLang parser/runtime.
    ysmEvaluateMolang(localTime, elapsedTime, deltaTime) {
      if (contextValues.bridgeFault === 'null-json') return 'null';
      calls.push({ localTime, elapsedTime, deltaTime });
      return JSON.stringify(expressions.map(expression => {
        switch (expression) {
          case 'ysm.head_yaw': return contextValues.yaw;
          case '5+ysm.head_yaw': return 5 + contextValues.yaw;
          case 'query.anim_time*16': return elapsedTime * 16;
          case 'query.life_time*16': return localTime * 16;
          case 'invalid expression': return null;
          default: throw new Error('Unexpected expression in bridge contract test: ' + expression);
        }
      }));
    },
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') + `
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    controls = { target: new THREE.Vector3(), update() {} };
    globalThis.api = { loadModelGeometry, loadAnimationData, playAnimation,
      stopAnimation, clearScene, resetCamera, getAnimationProgress,
      scene, camera, bone: id => boneGroups.get(id), actionTime: () => currentAnimAction?.time };
  `, sandbox);
  const api = sandbox.api;
  api.loadModelGeometry(JSON.stringify({ models: [{ id: 'main', bones: [
    { id: 'Root', name: 'Root', localPosition: [0, 0, 0] },
    { id: 'UpBody', name: 'UpBody', parentId: 'Root', localPosition: [0, 1, 0] },
    { id: 'Head', name: 'Head', parentId: 'UpBody', localPosition: [0, 1, 0] },
    { id: 'Hair', name: 'Hair', parentId: 'Head', localPosition: [0, 0.2, 0] },
  ], meshGroups: [{ id: 'mesh', boneId: 'Hair', positions: [-0.5,0,0, 0.5,0,0, 0,1,0],
    normals: [0,0,1, 0,0,1, 0,0,1], uvs: [0,0, 1,0, 0.5,1], indices: [0,1,2] }] }] }));
  return { ...api, calls, diagnostics, contextValues,
    load(animations) { api.loadAnimationData(JSON.stringify({ animations })); },
    advance(ms) {
      while (ms > 0) {
        const step = Math.min(ms, 100); ms -= step; now += step;
        const pending = [...frames.values()]; frames.clear();
        for (const fn of pending) fn(now);
      }
    },
  };
}

// Exact expression-bearing channels from
// _5Toubun/5Toubun_Itsuki-Nakano_v1.0.ysm, climbing (catalog b56fbe6).
const climbing = { animation_length: 1, bones: {
  Root: { rotation: [90, 0, 0], position: [0, 2, 19], scale: 1 },
  UpBody: { rotation: [0, 0, 'ysm.head_yaw'], position: 0 },
  Head: { rotation: [-90, 'ysm.head_yaw', 0], position: 0 },
} };

function finiteScene(h) {
  h.scene.updateMatrixWorld(true);
  h.scene.traverse(node => {
    for (const value of [...node.position, ...node.quaternion, ...node.scale, ...node.matrixWorld.elements])
      assert.ok(Number.isFinite(value), `Nonfinite transform: ${node.name}`);
    if (node.isMesh) {
      const p = new THREE.Vector3();
      for (let i = 0; i < node.geometry.attributes.position.count; i++) {
        p.fromBufferAttribute(node.geometry.attributes.position, i).applyMatrix4(node.matrixWorld);
        assert.ok([...p].every(Number.isFinite), 'Nonfinite transformed vertex');
      }
    }
  });
  assert.ok([...h.camera.position, ...h.camera.quaternion, ...h.camera.projectionMatrix.elements].every(Number.isFinite));
}

test('real climbing expressions keep the complete descendant hierarchy visible and camera reset finite', () => {
  const h = harness(); h.load({ climbing }); h.playAnimation('climbing'); h.advance(250);
  finiteScene(h); h.resetCamera(); finiteScene(h);
  assert.deepEqual(h.diagnostics, []);
});

test('expressions update at frame time and respond to nonzero context without reloading', () => {
  const h = harness();
  h.load({ dynamic: { animation_length: 1, bones: { UpBody: {
    rotation: [0, 0, '5+ysm.head_yaw'], position: ['query.anim_time*16', 'query.life_time*16', 0],
  } } } });
  h.playAnimation('dynamic'); h.advance(250);
  assert.ok(Math.abs(h.bone('UpBody').position.x + 0.25) < 1e-6);
  assert.ok(Math.abs(h.bone('UpBody').position.y - 1.25) < 1e-6);
  h.contextValues.yaw = 25; h.advance(250);
  const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 6));
  assert.ok(h.bone('UpBody').quaternion.angleTo(expected) < 0.001);
  h.advance(750);
  assert.ok(Math.abs(h.bone('UpBody').position.x + 1.25) < 1e-5);
  assert.ok(Math.abs(h.bone('UpBody').position.y - 1.25) < 1e-5);
  finiteScene(h); assert.deepEqual(h.diagnostics, []);
});

test('failed expression channels retain rest transforms and report a bounded diagnostic', () => {
  const h = harness();
  h.load({ invalid: { animation_length: 1, bones: { UpBody: {
    rotation: [0, 'invalid expression', 0], scale: ['invalid expression', 1, 1],
  } } } });
  h.playAnimation('invalid'); h.advance(1000); finiteScene(h);
  assert.deepEqual(h.bone('UpBody').scale.toArray(), [1, 1, 1]);
  assert.ok(h.bone('UpBody').quaternion.angleTo(new THREE.Quaternion()) < 1e-6);
  assert.ok(h.diagnostics.length > 0 && h.diagnostics.length <= 3);
});

test('invalid geometry cannot poison the camera and bounds use current visible transforms', () => {
  const h = harness();
  const before = h.camera.position.clone();
  h.bone('UpBody').quaternion.set(NaN, NaN, NaN, NaN);
  h.scene.updateMatrixWorld(true); // Match the rendered broken pose before reset.
  h.resetCamera();
  assert.ok([...h.camera.position, ...h.camera.quaternion].every(Number.isFinite));
  assert.ok(h.camera.position.distanceTo(before) < 1e-6);
  h.stopAnimation(); h.resetCamera(); finiteScene(h);
});

test('stopping and replaying before the next frame does not multiply animation time', () => {
  const h = harness(); h.load({ climbing });
  h.playAnimation('climbing'); h.stopAnimation(); h.playAnimation('climbing');
  h.advance(100);
  assert.ok(Math.abs(JSON.parse(h.getAnimationProgress()).time - 0.1) < 1e-6);
  h.stopAnimation(); h.advance(500); finiteScene(h);
  assert.deepEqual(h.bone('Root').position.toArray(), [0,0,0]);
});

test('binding-only negative control still produces NaN descendants for real MoLang input', () => {
  const h = harness(bindingOnly); h.load({ climbing }); h.playAnimation('climbing'); h.advance(250);
  assert.throws(() => finiteScene(h), /Nonfinite/);
});

test('zero-duration expression poses have finite loop time', () => {
  const h = harness();
  h.load({ zero: { animation_length: 0, bones: { Head: { rotation: [0, 'ysm.head_yaw', 0] } } } });
  h.playAnimation('zero'); h.advance(250);
  finiteScene(h); assert.ok(Number.isFinite(h.actionTime()));
});

for (const fault of ['configure', 'null-json']) {
  test(`MoLang bridge ${fault} failure is contained while numeric channels keep playing`, () => {
    const h = harness(); h.contextValues.bridgeFault = fault;
    h.load({ mixed: { animation_length: 1, bones: {
      Head: { scale: ['ysm.head_yaw', 1, 1] },
      Root: { position: { '0.0': [0,0,0], '1.0': [16,0,0] } },
    } } });
    h.playAnimation('mixed'); h.advance(250); finiteScene(h);
    assert.ok(Math.abs(h.bone('Root').position.x + 0.25) < 1e-6);
    assert.deepEqual(h.bone('Head').scale.toArray(), [1,1,1]);
    assert.ok(h.diagnostics.length > 0 && h.diagnostics.length <= 3);
  });
}
