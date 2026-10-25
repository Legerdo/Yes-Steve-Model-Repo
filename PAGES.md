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
2. Tests model indexing, URL encoding and common error conditions.
3. Builds a deterministic `models.json` from the GitHub Git tree API, with file sizes and a pinned Git revision. A local/offline build can read filenames from `git ls-tree` (without sizes).
4. Checks out **YSMViewer at `a30baf27425a9cc206af095600e3d98e4eb7f472`**, builds its `.NET 10` browser application and copies the contents of the published `wwwroot` into `dist/viewer/`.
5. Copies the upstream GPL-3.0 license and source URL, validates the deployment directory, then uploads and deploys the Pages artifact.

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

To test the actual viewer locally, install the .NET 10 SDK and `wasm-tools` workload. Check out the pinned YSMViewer source separately:

```powershell
dotnet workload install wasm-tools
dotnet publish .\YSMViewer.Browser\YSMViewer.Browser.csproj -c Release -p:WasmBuildNative=false -o .\publish
# Copy publish\wwwroot\* into this repository's dist\viewer directory.
# Copy upstream LICENSE to dist\viewer\COPYING.
```

Serve `dist/` over HTTP, not `file://` (WASM and the index use `fetch`):

```powershell
python -m http.server 8765 --directory dist
```

Run `node scripts/verify-dist.mjs dist` after the viewer assets have been copied.

## Compatibility and risks

- The browser viewer is an upstream project; basic 3D rendering, textures and keyframe animations are implemented, but parity with in-game animation controllers and physical MoLang is **not** guaranteed.
- Model files include encrypted YSM packages and ZIP archives in multiple format revisions. An individual corrupt or unsupported file can fail to parse. Check `/viewer/` directly if a preview is blank.
- The first model visit loads the WebAssembly application. Switching between models currently reloads the viewer iframe (intentional isolation; slower but avoids stale model state).
- Model bytes are served by GitHub Raw, which exposes public, commit-pinned URLs and sends `Access-Control-Allow-Origin: *` for the sampled model. GitHub Raw availability and CDN throttling are outside this site's control.
- Model authors and licenses vary. The original repository and any metadata embedded in each package are authoritative; this website does **not** grant additional model redistribution rights.
- The pinned upstream YSMViewer build reported NuGet advisories for `SixLabors.ImageSharp 3.1.11` at the time of integration. Before exposing arbitrary third-party uploads or public URL import features, review and upgrade the affected dependency in a controlled upstream revision.

## Licenses and upgrades

YSMViewer is GPL-3.0. Its compiled browser application is built from the pinned upstream source with the corresponding GPL text copied to `viewer/COPYING` and a link to exact source in `viewer/SOURCE.txt`. It is embedded in an iframe as a standalone application. The gallery's additional JavaScript is published as readable source in this repository.

To upgrade, change the pinned commit in the workflow, retest with representative `.ysm` and `.zip` files, and verify browser console errors, textures, animations and package format compatibility before merging.
