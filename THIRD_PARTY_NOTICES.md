# Third-party notices

This project uses open-source software. The lockfile is the authoritative inventory of exact versions. Run the following command before each release to audit production dependencies:

```powershell
corepack pnpm licenses list --prod
```

Key runtime dependencies:

| Package | Version | License | Source |
| --- | ---: | --- | --- |
| `@thatopen/components` | 3.4.6 | MIT | https://github.com/ThatOpen/engine_components |
| `@thatopen/fragments` | 3.4.5 | MIT | https://github.com/ThatOpen/engine_fragment |
| `web-ifc` | 0.0.77 | MPL-2.0 | https://github.com/ThatOpen/engine_web-ifc |
| `three` | 0.184.0 | MIT | https://github.com/mrdoob/three.js |
| `three-mesh-bvh` | 0.9.14 | MIT | https://github.com/gkjohnson/three-mesh-bvh |
| `@gltf-transform/core/extensions/functions` | 4.4.2 | Apache-2.0 | https://github.com/donmccurdy/glTF-Transform |
| `draco3dgltf` | 1.5.7 | Apache-2.0 | https://github.com/google/draco |
| `meshoptimizer` | 1.0.1 | MIT | https://github.com/zeux/meshoptimizer |
| `sharp` / platform package (transitive, Node-side optional) | 0.34.x | Apache-2.0; bundled libvips components include LGPL-3.0-or-later | https://github.com/lovell/sharp |
| `dxf-parser` | 1.1.2 | MIT | https://github.com/gdsestimating/dxf-parser |
| `occt-import-js` | 0.0.23 | LGPL-2.1 | https://github.com/kovacsv/occt-import-js |
| GNU LibreDWG (`dwg2dxf`, optional external converter) | 0.14 | GPL-3.0-or-later | https://github.com/LibreDWG/libredwg |
| `jszip` | 3.10.1 | MIT OR GPL-3.0-or-later | https://github.com/Stuk/jszip |
| `react` / `react-dom` | 19.2.8 | MIT | https://github.com/facebook/react |
| `lucide-react` | 0.468.0 | ISC | https://github.com/lucide-icons/lucide |

## MPL-2.0 note

`web-ifc` is distributed under MPL-2.0. Using the unmodified package does not require the BIM Studio application as a whole to be open-sourced. If an executable distribution includes `web-ifc`, retain its copyright and license notices and tell recipients where the corresponding `web-ifc` source is available. Modifications made directly to MPL-covered files must remain available under MPL-2.0 when distributed.

This repository does not vendor BIMI/BIMFACE viewer code or source from Aedifex, Pascal Editor, Massing, or xeokit.

## STEP and DWG converter notes

`occt-import-js` runs as a replaceable WASM import boundary in the API and is covered by LGPL-2.1. Retain its license and source offer when distributing the application, and publish modifications made directly to LGPL-covered files under the applicable terms.

GNU LibreDWG is an optional GPL-3.0-or-later executable invoked as a separate process to produce DXF. The installer keeps the converter outside the application bundles. Internal use does not distribute the converter; if a deployment package is delivered outside the organization, include the GPL license and corresponding source offer and have the distribution model reviewed before release.

## Proprietary conversion tools

RVT conversion through an installed Autodesk Revit instance is separate from the browser viewer. The deployment organization is responsible for valid Autodesk/Revit licenses on conversion workers. Unity Asset Transformer Toolkit (formerly Pixyz Plugin) is not a dependency of this project.
