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
2. Checks out the pinned viewer and tests model indexing, URL encoding, actual Three.js animation transforms, expression updates and camera bounds.
3. Builds a deterministic `models.json` from the GitHub Git tree API, with file sizes and a pinned Git revision. A local/offline build can read filenames from `git ls-tree` (without sizes).
4. Uses **YSMViewer at `a30baf27425a9cc206af095600e3d98e4eb7f472`**, applies the browser [logging compatibility patch](scripts/patch-browser-logging.mjs) and [animation patch](scripts/patch-browser-animation.mjs), tests the shared and browser MoLang runtimes, builds the `.NET 10` browser application and copies the published `wwwroot` into `dist/viewer/`.
5. Verifies that the packaged renderer and interop entry point match the patched source, copies the upstream GPL-3.0 license and source links, and validates the deployment directory.
6. Runs the packaged WebAssembly application in Chromium against the actual Itsuki `.ysm` and Alexten22 ZIP packages. Publication requires finite model/camera transforms, visible geometry after camera reset, movement, stop/model-switch checks and managed expression evaluation. Saves JSON results and screenshots as a workflow artifact before uploading and deploying Pages.

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
node --test tests/gallery.test.mjs tests/browser-animation.test.mjs tests/browser-molang.test.mjs
node scripts/patch-browser-logging.mjs .vendor/ysmviewer
node scripts/patch-browser-animation.mjs .vendor/ysmviewer
dotnet test .vendor/ysmviewer/YSMViewer.Core.Tests/YSMViewer.Core.Tests.csproj -c Release
dotnet run --project tests/molang-runtime/MolangRuntimeTests.csproj -c Release
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

The separate visibility regression uses unchanged expression strings from Itsuki's `climbing` channels. The former UUID-only renderer still produces `NaN` in `Head`/`UpBody` and their descendants; the test retains it as a negative control. Set `$env:YSM_TEST_BINDING_ONLY = '1'` to exercise that older behavior explicitly, then remove the variable for normal tests.

The [managed evaluator](scripts/browser-animation/BrowserMolangEvaluator.cs) reuses the upstream MoLang parser, runtime, math and model functions. The [track adapter](scripts/browser-animation/evaluated-tracks.js) evaluates active clip expressions before each mixer update and changes the existing track value arrays in place. Numeric tracks keep the Three.js binding/interpolation path. Head-angle aliases and animation clocks follow the [YSM MoLang reference](https://yesstevemodel.github.io/wiki/molang/ref/); game-state inputs use neutral preview values until supplied. Expressions are compiled once per model and frame results are shared for repeated expressions. This is a single-clip preview, not an implementation of in-game controllers or stateful physics parity.

Failed parse/evaluation results are explicit null samples. A failed channel uses its rest transform (including scale 1), with a bounded console warning. Float32 track overflow is checked too. Camera fitting updates ancestor matrices, uses visible geometry, and excludes nonfinite bounds; without valid bounds it preserves the current camera. Playback generations prevent a stopped RAF callback from starting a second loop. Zero-length static poses use the existing one-second preview default or the last keyframe time, whichever is longer.

The managed runtime tests check nonzero head angles, arithmetic, changing time, loops, custom functions, failure results and model context reset. The browser test loads the actual `.ysm`/ZIP packages, samples `climb`, `climbing`, `walk` and `run`, checks **all** local/world matrices and transformed vertices with finite-number checks, resets the camera, and tests stopping and model changes. A synthetic expression clip additionally proves nonzero context and time-dependent expressions through the actual WASM bridge. Console silence alone is never a pass criterion.

GPU-less Chromium can make Avalonia 12 reject its preferred WebGL UI contexts and use its supported Software2D fallback. The test retains those exact, source-checked startup diagnostics and accepts them only when the same canvas has an application-created 2D context with visible painted pixels. Unrecovered fallback, all other browser errors and animation warnings still fail the deployment gate; the Three.js model checks remain mandatory.

With Python Playwright 1.61.0 and Chrome already available on Windows, run the same packaged-app check with:

```powershell
python tests/browser-animation-smoke.py --dist dist --browser-channel chrome --output .vendor/animation-smoke
```

The script serves the directory with the correct JavaScript/WebAssembly MIME types, closes its browser/server when finished, and saves screenshots and `results.json`. CI installs its own pinned Playwright Chromium. A deployed version can be checked with `--url https://legerdo.github.io/Yes-Steve-Model-Repo/ --revision <commit-sha>` instead of `--dist`.

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
