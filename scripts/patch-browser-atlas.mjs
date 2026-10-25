// With MSAA, ordinary UV interpolation can sample outside a covered triangle.
// Pixel-art atlases then leak neighboring colors along otherwise solid faces.
const materialFactory = `function createModelMaterial(parameters) {
    const material = new THREE.MeshBasicMaterial(parameters);
    material.onBeforeCompile = shader => {
        // Keep map samples inside the rasterized face while retaining MSAA,
        // authored UVs, alpha handling and the normal depth/occlusion path.
        shader.vertexShader = shader.vertexShader.replace('#include <uv_pars_vertex>',
            THREE.ShaderChunk.uv_pars_vertex.replace('varying vec2 vMapUv;', 'centroid varying vec2 vMapUv;'));
        shader.fragmentShader = shader.fragmentShader.replace('#include <uv_pars_fragment>',
            THREE.ShaderChunk.uv_pars_fragment.replace('varying vec2 vMapUv;', 'centroid varying vec2 vMapUv;'));
    };
    material.customProgramCacheKey = () => 'ysm-atlas-centroid-v1';
    return material;
}

`;

export function patchBrowserAtlasSource(source) {
    const constructor = 'new THREE.MeshBasicMaterial(';
    const insertion = 'function getOrCreateMaterial(textureId) {';
    if (source.split(constructor).length !== 4 || source.split(insertion).length !== 2) {
        throw new Error('Pinned browser material construction changed; review upstream before upgrading');
    }
    return source.replaceAll(constructor, 'createModelMaterial(')
        .replace(insertion, materialFactory + insertion);
}
