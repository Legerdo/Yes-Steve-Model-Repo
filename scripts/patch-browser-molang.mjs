import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const runtime = readFileSync(new URL('./browser-animation/evaluated-tracks.js', import.meta.url), 'utf8');
const evaluator = readFileSync(new URL('./browser-animation/BrowserMolangEvaluator.cs', import.meta.url), 'utf8');

function replaceOnce(source, original, replacement) {
  if (source.split(original).length !== 2) throw new Error('Pinned MoLang integration changed; review upstream before upgrading');
  return source.replace(original, replacement);
}

export function patchBrowserMolangRenderer(source) {
  let result = source;
  result = replaceOnce(result, 'const MAX_DELTA_TIME      = 0.1;',
    'const MAX_DELTA_TIME      = 0.1;\nconst DEFAULT_ANIMATION_DURATION = 1; // Upstream preview default for static poses.');
  result = replaceOnce(result, '            const duration = animData.animation_length ?? animData.length ?? 1;',
    `            const requestedDuration = Number(animData.animation_length ?? animData.length ?? DEFAULT_ANIMATION_DURATION);
            // A zero-length static pose must not enter the mixer's modulo-zero loop.
            const duration = Number.isFinite(requestedDuration) && requestedDuration > 0
                ? requestedDuration
                : Math.max(DEFAULT_ANIMATION_DURATION, ...tracks.map(track => track.times[track.times.length - 1]));`);
  const start = result.indexOf('function buildQuaternionTrack(');
  const end = result.indexOf('function getInitialPosition(', start);
  if (start < 0 || end < start) throw new Error('Pinned animation track builders changed');
  result = result.slice(0, start) + runtime + '\n\n' + result.slice(end);
  result = replaceOnce(result, 'let animLoopActive     = false;', 'let animLoopActive     = false;\nlet animLoopGeneration = 0;');
  result = replaceOnce(result,
    '    currentAnimAction = animMixer.clipAction(clip);\n    currentAnimAction.play();',
    '    prepareAnimationExpressions(clip);\n    currentAnimAction = animMixer.clipAction(clip);\n    currentAnimAction.reset().play();');
  result = replaceOnce(result, '    stopAnimLoop();\n    resetBoneTransforms();',
    '    stopAnimLoop();\n    activeExpressionProgram = null;\n    resetBoneTransforms();');
  result = replaceOnce(result, '    animLoopActive = true;\n\n    let lastTime',
    '    animLoopActive = true;\n    const generation = ++animLoopGeneration;\n\n    let lastTime');
  result = replaceOnce(result, '        if (!animLoopActive) return;',
    '        if (!animLoopActive || generation !== animLoopGeneration) return;');
  result = replaceOnce(result, '            if (animMixer) animMixer.update(dt);',
    '            updateExpressionsBeforeMixer(dt);\n            if (animMixer) animMixer.update(dt);');
  result = replaceOnce(result, 'function stopAnimLoop() {\n    animLoopActive = false;\n}',
    'function stopAnimLoop() {\n    animLoopActive = false;\n    animLoopGeneration++;\n}');
  result = replaceOnce(result, '    animClips = [];\n    animLoopActive = false;',
    '    animClips = [];\n    activeExpressionProgram = null;\n    animationWarnings.clear();\n    stopAnimLoop();');
  result = replaceOnce(result, `function computeSceneBoundingBox() {
    const box = new THREE.Box3();
    scene.traverse((child) => {
        if (child.isMesh) box.expandByObject(child);
    });
    return box.isEmpty() ? null : box;
}`, `function computeSceneBoundingBox() {
    const box = new THREE.Box3();
    // Ancestor matrices must reflect the current pose, including an immediate stop.
    scene.updateMatrixWorld(true);
    scene.traverseVisible((child) => {
        if (!child.isMesh || !child.geometry) return;
        if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
        const bounds = child.geometry.boundingBox?.clone().applyMatrix4(child.matrixWorld);
        if (!bounds || bounds.isEmpty() || ![...bounds.min, ...bounds.max].every(Number.isFinite)) {
            warnAnimationOnce('bounds:' + child.uuid, 'Ignoring invalid model bounds while fitting the camera.');
            return;
        }
        box.union(bounds);
    });
    return box.isEmpty() ? null : box;
}`);
  const distance = '    const distance = Math.max(size.x, size.y, size.z) * CAMERA_FIT_PADDING + CAMERA_FIT_OFFSET;';
  if (result.split(distance).length !== 3) throw new Error('Pinned camera fitting changed');
  result = result.replaceAll(distance, distance + '\n    if (![distance, ...center, ...size].every(Number.isFinite)) return;');
  return result;
}

const managedFiles = [
  ['YSMViewer/Services/Molang/MolangService.cs', '60bd0ba50c47993a3066d77dbb38bbe833bfcbd1b4098290f3e9f42a051dbccd', [
    ['    public MolangService()\n', '    public MolangService(Action<MoLangEnvironment>? configure = null)\n'],
    ['        _runtime = new MoLangRuntime(env);', '        configure?.Invoke(env);\n        _runtime = new MoLangRuntime(env);'],
    ['    public float EvaluateString(string expression)', `    // Browser animation needs an explicit failure result rather than the
    // native preview's forgiving zero fallback. The parser/runtime are shared.
    public float EvaluateStrict(IExpression expression)
    {
        return expression is NumberExpression number
            ? (float)number.Evaluate(null!, _runtime.Environment).AsDouble()
            : (float)_runtime.Execute(expression, GetContext()).AsDouble();
    }

    public float EvaluateString(string expression)`],
  ]],
  ['YSMViewer.Browser/Rendering/ThreeJs/ThreeJsRenderer.cs', '5a5c4ecc3838eff5f82f667f155c13249d76b4e8b943a72d84d3cfe760337ba8', [
    ['    public MolangService? MolangService => null;', '    public MolangService? MolangService => ThreeJsInterop.Molang?.Service;'],
    ['        _currentDocument = document;', `        _currentDocument = document;
        ThreeJsInterop.Molang = new BrowserMolangEvaluator();
        foreach (var function in document.Functions)
            ThreeJsInterop.Molang.Service.RegisterFunction(function.Name, function.Data);`],
    ['        _currentDocument = null;', '        _currentDocument = null;\n        ThreeJsInterop.Molang = null;'],
  ]],
  ['YSMViewer.Browser/Rendering/ThreeJs/ThreeJsInterop.cs', '966922fd8cb7f22b98bb9524d5206986ae6f5759b7bdc6b2024e45acedf52555', [
    ['    public static event Action? RestoreButtonClicked;', `    public static YSMViewer.Services.Molang.BrowserMolangEvaluator? Molang { get; set; }

    [JSExport]
    public static void ConfigureMolang(string expressions) => Molang?.Configure(expressions);

    [JSExport]
    public static string EvaluateMolang(double localTime, double elapsedTime, double deltaTime)
        => Molang?.Evaluate(localTime, elapsedTime, deltaTime) ?? "[]";

    [JSExport]
    public static void SetMolangVariable(string name, double value) => Molang?.SetVariable(name, value);

    public static event Action? RestoreButtonClicked;`],
  ]],
  ['YSMViewer.Browser/wwwroot/main.js', '3a431a9206d6ee23b573a9761599ddd13642bed619a0fbaf7a579a1014f2d43b', [
    ['const exportsPromise = getAssemblyExports("YSMViewer.Browser.dll");', `const exportsPromise = getAssemblyExports("YSMViewer.Browser.dll");
// Install the managed evaluator before runMain can load a model or play a clip.
const animationInterop = (await exportsPromise).YSMViewer.Rendering.ThreeJs.ThreeJsInterop;
globalThis.ysmConfigureMolang = animationInterop.ConfigureMolang;
globalThis.ysmEvaluateMolang = animationInterop.EvaluateMolang;
globalThis.ysmSetMolangVariable = animationInterop.SetMolangVariable;`],
  ]],
];

export async function prepareBrowserMolangFiles(root) {
  const outputs = [];
  for (const [relative, expected, changes] of managedFiles) {
    const path = join(root, relative);
    const original = await readFile(path, 'utf8');
    let source = original.replaceAll('\r\n', '\n');
    if (createHash('sha256').update(source).digest('hex') !== expected) {
      throw new Error(`Pinned ${relative} changed; review upstream before upgrading`);
    }
    for (const [from, to] of changes) source = replaceOnce(source, from, to);
    outputs.push({ path, text: original.includes('\r\n') ? source.replaceAll('\n', '\r\n') : source });
  }
  const path = join(root, 'YSMViewer/Services/Molang/BrowserMolangEvaluator.cs');
  try {
    await readFile(path);
    throw new Error('Browser MoLang evaluator already exists; use a clean pinned checkout');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  outputs.push({ path, text: evaluator });
  return outputs;
}
