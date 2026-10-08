# Font sources

The app uses the typefaces of `DESIGN.md`. No font file is committed to this repository.
`mac/scripts/fetch-fonts.sh` downloads each one from its official source when the `mac-app.yml`
workflow runs, checks its SHA-256, and copies it here; `mac/scripts/make-app.sh` then copies the
files into `Relay.app/Contents/Resources/Fonts/`. If a check fails, the workflow stops, and someone
reads the new file and its license before changing the value in the script and in this table.

| File | Source | SHA-256 |
|---|---|---|
| `Satoshi-Bold.otf` | `Satoshi_Complete/Fonts/OTF/Satoshi-Bold.otf` in https://api.fontshare.com/v2/fonts/download/satoshi | `50e4f9b7c1864c50761d729d6001bfac708c80457fa6fc41559a8ab1bd2573ff` |
| `Satoshi-LICENSE.txt` | `Satoshi_Complete/License/FFL.txt` in the same file | `145e7fe2429a3336ba215c070ef722000e01348a3e1baaa127e871bb5012f554` |
| `PublicSans-Regular.otf` | `fonts/otf/PublicSans-Regular.otf` in https://github.com/uswds/public-sans/releases/download/v2.001/public-sans-v2.001.zip | `89cca4915bd88489323ad0d0107f7cd1dc81164416584f3c3c6da00e187cd581` |
| `PublicSans-Medium.otf` | `fonts/otf/PublicSans-Medium.otf` in the same file | `dd903e97179c1e8293a30f2a50474819cac10ab18579aa5f1b63cb72f23a50dc` |
| `PublicSans-SemiBold.otf` | `fonts/otf/PublicSans-SemiBold.otf` in the same file | `57af521ce5bc5a3495293f83051765c32d45d04696218bf0cff2ac66a65ba849` |
| `PublicSans-LICENSE.txt` | `OFL.txt` in the same file | `157a9e77f7580246e97c769490e2e977ae94399f9d30f4556015c41fe8c28bac` |
| `IBMPlexMono-Regular.otf` | `ibm-plex-mono/fonts/complete/otf/IBMPlexMono-Regular.otf` in https://github.com/IBM/plex/releases/download/%40ibm/plex-mono%402.5.0/ibm-plex-mono.zip | `372fe8f8a459baef84ee346b0a478084e80c46bd299a0c27bcb0f3412f5a9d28` |
| `IBMPlexMono-Medium.otf` | `ibm-plex-mono/fonts/complete/otf/IBMPlexMono-Medium.otf` in the same file | `f7db820bddfbf7fce52946e69fee89a150938d401d82850cdf975b2c4c31b97b` |
| `IBMPlexMono-LICENSE.txt` | `ibm-plex-mono/LICENSE.txt` in the same file | `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da` |

## Licenses

- **Public Sans** (version 2.001) and **IBM Plex Mono** (version 2.5.0) use the SIL Open Font
  License 1.1, which allows bundling the fonts in an app when the license goes with them.
- **Satoshi** uses the ITF Free Font License 2.0 of 17 August 2026. Section 01 allows embedding the
  font in desktop applications; section 02 forbids sharing the font files through a repository or
  another download service. So the files are downloaded at build time and only shipped inside the
  app. Josué decides whether this reading is right.

The PostScript names that `FontLoader` and the tests use are `Satoshi-Bold`, `PublicSans-Regular`,
`PublicSans-Medium`, `PublicSans-SemiBold`, `IBMPlexMono` and `IBMPlexMono-Medm`.
