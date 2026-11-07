# Contributing to Remote Desktop

## Development

```bash
npm run build      # build into dist/
npm run test       # run this plugin's tests
npm run typecheck  # type-check this plugin
npm run validate   # check manifest.json
npm run format     # format the code with Prettier
```

The RDP engine is Rust in `native/engine`. `npm run build:engine` rebuilds the committed WASM in `src/backend/engine/wasm` (needs rustup, the wasm32 target and wasm-bindgen-cli 0.2.104). Its graphics tests run in wasm:

```bash
cd native/engine
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner cargo test --locked --target wasm32-unknown-unknown graphics_tests
```

## Docs

The docs for this plugin are in [docs/](docs/) and are published at https://docs.termix.site/plugins/remote-desktop. Settings, permissions, services, environment variables and the API reference are made from `manifest.json` and the `@openapi` comments in the code, so keep those up to date instead of writing them by hand. See [writing docs](https://docs.termix.site/develop/docs).
