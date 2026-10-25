# YSM Character Gallery — GitHub Pages

Static, searchable YSM character catalog and an embedded browser build of [DrAbcOfficial/YSMViewer](https://github.com/DrAbcOfficial/YSMViewer).

## Features

- Search 1,000+ tracked character packages by name and path.
- Filter by category and `.ysm` / `.zip`, paginate results.
- Orbit/zoom/pan the selected character with the bundled YSMViewer WebAssembly renderer.
- Open the selected model directly in the bundled viewer, open its GitHub source, download the package, or copy a per-model link (`?model=...`).
- No model archive duplication in Pages: only the selected package is requested from `raw.githubusercontent.com`.

## Deployment

The [Pages workflow](.github/workflows/pages.yml) is the only publishing pipeline. It:

1. Sparse-checks out this repository with Git blob filtering, so the model files are not downloaded during the build.
2. Checks out the pinned viewer and tests model indexing, URL encoding and actual Three.js animation transforms.
3. Builds a deterministic `models.json` from the GitHub Git tree API, with file sizes and a pinned Git revision. A local/offline build can read filenames from `git ls-tree` (without sizes).
4. Uses **YSMViewer at `a30baf27425a9cc206af095600e3d98e4eb7f472`**, applies the browser [logging compatibility patch](scripts/patch-browser-logging.mjs) and [animation binding patch](scripts/patch-browser-animation.mjs), builds the `.NET 10` browser application and copies the published `wwwroot` into `dist/viewer/`.
5. Verifies that the packaged renderer matches the patched source, copies the upstream GPL-3.0 license and links to both patches, validates the deployment directory, then uploads and deploys the Pages artifact.

To enable publishing, select **Settings → Pages → Build and deployment → Source: GitHub Actions**. On the initial merge into `main`, the `Build and deploy YSM model gallery` workflow should run. The expected address is:

<https://legerdo.github.io/Yes-Steve-Model-Repo/>

The website requires HTTPS. For a customized Pages domain, relative URLs to `./viewer/` and `./models.json` continue to work.

### Local development (Windows 11 / PowerShell)

Use a sparse clone of this repository; do not download the model blobs just to build the catalog.

```powershell
node --test tests/gallery.test.mjs
node scripts/build-model-index.mjs --out dist/models.json
Copy-Item pages\* dist\ -Recurse -Force
```

To test the actual viewer locally, install the .NET 10 SDK and `wasm-tools` workload. From this repository, use a fresh checkout of the pinned YSMViewer source:

```powershell
git clone --filter=blob:none https://github.com/DrAbcOfficial/YSMViewer.git .vendor/ysmviewer
git -C .vendor/ysmviewer checkout --detach a30baf27425a9cc206af095600e3d98e4eb7f472
node --test tests/gallery.test.mjs tests/browser-animation.test.mjs
node scripts/patch-browser-logging.mjs .vendor/ysmviewer
node scripts/patch-browser-animation.mjs .vendor/ysmviewer
dotnet workload install wasm-tools
dotnet publish .vendor/ysmviewer/YSMViewer.Browser/YSMViewer.Browser.csproj -c Release -p:WasmBuildNative=true -o .\publish
# Copy publish\wwwroot\* into this repository's dist\viewer directory.
# Copy upstream LICENSE to dist\viewer\COPYING.
```

Serve `dist/` over HTTP, not `file://` (WASM and the index use `fetch`):

```powershell
python -m http.server 8765 --directory dist
```

Run `node scripts/verify-dist.mjs dist` after the viewer assets have been copied.

The viewer uses SkiaSharp, which requires native WebAssembly linking. **Do not pass `WasmBuildNative=false`** even if the publish command succeeds: that can yield a site that crashes at `SkiaSharp.SKImageInfo` initialization. When the Emscripten toolchain on Windows is missing or not configured in MSBuild's environment, use the GitHub Actions Linux build instead of producing a nonfunctional binary.

### Browser animation regression

The pinned upstream renderer builds track names such as `.children[2].children[0].quaternion`. Three.js interprets the nested indices as one property binding, so selecting an animation advances its timer but leaves the bones still and emits `THREE.PropertyBinding` errors. The animation patch binds each track to the target bone's `Object3D.uuid` and removes the unused path builder. Both source patches reject unexpected upstream changes rather than silently publishing an unpatched viewer.

The animation regression tests use the pinned viewer's own Three.js implementation and renderer code. They assert numeric bone transforms rather than treating an advancing playback clock as success. The viewer source must be present at `.vendor/ysmviewer`, or at the path set in `YSMVIEWER_SOURCE`; a missing checkout is an error. Run these tests before applying the source patches.

The tests retain the original renderer as a negative control. To run the positive playback assertions against that broken renderer explicitly, set `$env:YSM_TEST_UNPATCHED = '1'` and run `node --test tests/browser-animation.test.mjs`; the two playback tests are expected to fail. Remove that process-local environment variable before running the fixed suite.

Browser smoke coverage for this fix includes clicking `climb` in the default `_5Toubun/5Toubun_Itsuki-Nakano_v1.0.ysm` model, playing its `walk` and `run` clips, stopping playback, and switching to `_Alexten22/Alexten22_1.0.0.zip` to play `walk`. These checks compare changing bone transforms and check console errors; they do not establish in-game parity for every model or MoLang controller.

## Compatibility and risks

- The browser viewer is an upstream project; basic 3D rendering, textures and keyframe animations are implemented, but parity with in-game animation controllers and physical MoLang is **not** guaranteed.
- Model files include encrypted YSM packages and ZIP archives in multiple format revisions. An individual corrupt or unsupported file can fail to parse. Check `/viewer/` directly if a preview is blank.
- The first model visit loads the WebAssembly application. Switching between models currently reloads the viewer iframe (intentional isolation; slower but avoids stale model state).
- Model bytes are served by GitHub Raw, which exposes public, commit-pinned URLs and sends `Access-Control-Allow-Origin: *` for the sampled model. GitHub Raw availability and CDN throttling are outside this site's control.
- Model authors and licenses vary. The original repository and any metadata embedded in each package are authoritative; this website does **not** grant additional model redistribution rights.
- The pinned upstream YSMViewer build reported NuGet advisories for `SixLabors.ImageSharp 3.1.11` at the time of integration. Before exposing arbitrary third-party uploads or public URL import features, review and upgrade the affected dependency in a controlled upstream revision.

## Licenses and upgrades

YSMViewer is GPL-3.0. Its compiled browser application is built from the pinned upstream source with the corresponding GPL text copied to `viewer/COPYING` and links to the exact upstream source and both browser compatibility patches in `viewer/SOURCE.txt`. It is embedded in an iframe as a standalone application. The gallery's additional JavaScript is published as readable source in this repository.

To upgrade, change the pinned commit in the workflow, retest with representative `.ysm` and `.zip` files, and verify browser console errors, textures, animations and package format compatibility before merging.
