# Vendored fonts

These files are bundled so the app loads no resources off the network — the renderer's CSP is
`default-src 'self'`, and a webfont request would simply be blocked.

| File | Font | Author | License |
|------|------|--------|---------|
| `Rajdhani-Medium.ttf`, `Rajdhani-SemiBold.ttf` | Rajdhani | Indian Type Foundry | SIL Open Font License 1.1 |
| `ShareTechMono-Regular.ttf` | Share Tech Mono | Carrois Apostrophe | SIL Open Font License 1.1 |

Both are Google Fonts releases: <https://fonts.google.com/specimen/Rajdhani>,
<https://fonts.google.com/specimen/Share+Tech+Mono>. The OFL permits bundling and redistribution,
including in a packaged application, provided the fonts are not sold on their own and this notice
travels with them. Full licence text: <https://openfontlicense.org/>.

Orbitron was vendored here until 2026-08-12 and was removed with the display face it belonged to.
