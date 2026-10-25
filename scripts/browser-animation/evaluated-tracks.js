// Inserted into the pinned renderer by patch-browser-animation.mjs.
// Three.js continues to own track binding, interpolation and playback. Only
// expression-bearing samples are refreshed through the shared managed runtime.
const evaluatedTrackData = new WeakMap();
const animationWarnings = new Set();
let activeExpressionProgram = null;

function warnAnimationOnce(key, message) {
    if (animationWarnings.has(key)) return;
    animationWarnings.add(key);
    console.warn('[YSM-Three] ' + message);
}

function normalizeKeyframes(channel) {
    if (Array.isArray(channel) || typeof channel === 'number' || typeof channel === 'string') {
        return { 0: channel };
    }
    return channel && typeof channel === 'object' ? channel : {};
}

function toVector3Array(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'number' || typeof value === 'string') return [value, value, value];
    if (value && typeof value === 'object') {
        if (value.post !== undefined) return toVector3Array(value.post);
        if (value.pre !== undefined) return toVector3Array(value.pre);
    }
    return null;
}

function buildQuaternionTrack(path, channel, boneObj) {
    return buildEvaluatedTrack(path, channel, boneObj, 'rotation');
}

function buildPositionTrack(path, channel, boneObj) {
    return buildEvaluatedTrack(path, channel, boneObj, 'position');
}

function buildScaleTrack(path, channel, boneObj) {
    return buildEvaluatedTrack(path, channel, boneObj, 'scale');
}

function buildEvaluatedTrack(path, channel, boneObj, kind) {
    const samples = Object.entries(normalizeKeyframes(channel))
        .map(([time, value]) => ({ time: Number(time), value: toVector3Array(value) }))
        .filter(({ time, value }) => Number.isFinite(time) && time >= 0 && value?.length >= 3)
        .sort((a, b) => a.time - b.time);
    if (!samples.length) return null;

    const data = { path, kind, samples, expressions: new Set(),
        basePosition: getInitialPosition(boneObj),
        baseQuaternion: getInitialQuaternion(boneObj),
        baseScale: getInitialScale(boneObj) };
    for (const sample of samples) {
        sample.value = sample.value.slice(0, 3).map(value => {
            if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
                return Number(value);
            }
            if (typeof value === 'string') data.expressions.add(value);
            return value;
        });
    }
    const stride = kind === 'rotation' ? 4 : 3;
    const values = new Float32Array(samples.length * stride);
    const track = kind === 'rotation'
        ? new THREE.QuaternionKeyframeTrack(path, samples.map(s => s.time), values)
        : new THREE.VectorKeyframeTrack(path, samples.map(s => s.time), values);
    evaluatedTrackData.set(track, data);
    writeEvaluatedSamples(track, data, null);
    return track;
}

function writeEvaluatedSamples(track, data, evaluated) {
    const neutral = data.kind === 'scale' ? [1, 1, 1] : [0, 0, 0];
    for (let index = 0; index < data.samples.length; index++) {
        const raw = data.samples[index].value;
        let vector = raw.map(value => typeof value === 'string' ? evaluated?.get(value) : value);
        if (!vector.every(Number.isFinite)) {
            if (evaluated || !raw.some(value => typeof value === 'string')) {
                warnAnimationOnce(data.path, 'Invalid animation channel ' + data.path + '; using its rest transform.');
            }
            vector = neutral;
        }
        let result;
        if (data.kind === 'rotation') {
            const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
                -vector[0] * Math.PI / 180, -vector[1] * Math.PI / 180, vector[2] * Math.PI / 180, 'XYZ'));
            result = rotation.premultiply(data.baseQuaternion).toArray();
        } else if (data.kind === 'position') {
            result = [data.basePosition.x - vector[0] / 16,
                data.basePosition.y + vector[1] / 16, data.basePosition.z + vector[2] / 16];
        } else {
            result = [data.baseScale.x * vector[0], data.baseScale.y * vector[1], data.baseScale.z * vector[2]];
        }
        // Guard the actual Float32 track representation as well as JS doubles.
        if (!result.every(value => Number.isFinite(Math.fround(value)))) {
            warnAnimationOnce(data.path, 'Nonfinite animation transform ' + data.path + '; using its rest transform.');
            result = (data.kind === 'rotation' ? data.baseQuaternion :
                data.kind === 'position' ? data.basePosition : data.baseScale).toArray();
        }
        track.values.set(result, index * result.length);
    }
}

function prepareAnimationExpressions(clip) {
    const tracks = clip.tracks.filter(track => evaluatedTrackData.get(track)?.expressions.size);
    const expressions = [...new Set(tracks.flatMap(track => [...evaluatedTrackData.get(track).expressions]))];
    activeExpressionProgram = expressions.length ? { clip, tracks, expressions, ready: false } : null;
    if (!activeExpressionProgram) return;
    if (typeof globalThis.ysmConfigureMolang !== 'function') {
        warnAnimationOnce('molang-bridge', 'MoLang evaluator is unavailable; expression channels use their rest transforms.');
        return;
    }
    try {
        globalThis.ysmConfigureMolang(JSON.stringify(expressions));
        activeExpressionProgram.ready = true;
    } catch (error) {
        warnAnimationOnce('molang-configuration', 'MoLang setup failed; expression channels use their rest transforms: ' + error);
    }
    updateAnimationExpressions(0, 0, 0);
}

function updateAnimationExpressions(localTime, elapsedTime, deltaTime) {
    const program = activeExpressionProgram;
    if (!program) return;
    let values = [];
    try {
        if (program.ready && typeof globalThis.ysmEvaluateMolang === 'function') {
            const result = JSON.parse(globalThis.ysmEvaluateMolang(localTime, elapsedTime, deltaTime));
            if (!Array.isArray(result)) throw new Error('Expected a MoLang result array');
            values = result;
        }
    } catch (error) {
        warnAnimationOnce('molang-evaluation', 'MoLang evaluation failed; expression channels use their rest transforms: ' + error);
    }
    const evaluated = new Map(program.expressions.map((expression, i) => [expression, values[i]]));
    for (const track of program.tracks) writeEvaluatedSamples(track, evaluatedTrackData.get(track), evaluated);
}

function updateExpressionsBeforeMixer(deltaTime) {
    if (!activeExpressionProgram || !currentAnimAction) return;
    const delta = deltaTime * animMixer.timeScale;
    const duration = currentAnimAction.getClip().duration;
    let localTime = currentAnimAction.time + delta * currentAnimAction.getEffectiveTimeScale();
    if (duration > 0 && currentAnimAction.loop === THREE.LoopRepeat) {
        localTime = ((localTime % duration) + duration) % duration;
    } else {
        localTime = Math.max(0, Math.min(localTime, duration));
    }
    updateAnimationExpressions(localTime, animMixer.time + delta, delta);
}
