# FactoryMachine.glb

Kenney Factory Kit 3.0, `Models/GLB format/machine.glb`.

- Creator: Kenney (`https://kenney.nl/assets/factory-kit`)
- License: Creative Commons Zero 1.0 (`https://creativecommons.org/publicdomain/zero/1.0/`)
- Source archive: `data/external-assets/open-packs/factory.zip`, SHA-256 `7e31fb2308e90304672bd15cd18fa9d9f02c03731a8cbc57a8e3e1c181dfb0a7`
- Source GLB SHA-256: `a39e3042bcb7789274428357383317d70e1c31906e5301c99e7d9e90ac584863`
- Source texture `Models/GLB format/Textures/colormap.png` SHA-256: `35d7bd6900dde0208429eeaec87fa17fbf024ed59f3f4eab54bc92802eba9dd7`
- Derived `FactoryMachine.glb` SHA-256: `7fd1f33c2b4cd6f9fbfe3cc1769cbc8aeb04c21c46d610d5d0105a21ef2995b4`

The archive's `License.txt` declares CC0 for the Factory Kit. Run `node packages/deep-engine/scripts/prepareT00S1Factory.mjs` from the repository root to regenerate the derived GLB. That script embeds the adjacent PNG into the GLB buffer and replaces its external image URI, leaving mesh geometry and material settings unchanged. This makes the benchmark asset self-contained and usable offline.
