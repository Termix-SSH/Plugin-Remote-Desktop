# Built-in RDP audio troubleshooting

The built-in engine sends negotiated 16-bit PCM through Guacamole's raw audio
player. Click or press a key inside the remote desktop to allow the browser's
shared audio context to start. Browsers may initially suspend it under autoplay
policy. Newly joined viewers and recordings started during playback receive the
active audio stream declaration before subsequent PCM packets.

For a silent Windows session, distinguish these stages:

- `rdpsnd formats requested`: the server reached audio format negotiation.
- `rdpsnd first wave`: the native handler received its first wave.
- `rdpsnd audio sent`: the worker emitted PCM; increasing byte counts prove
  continued transport, not audible playback or non-silent samples.

These messages use the application's **debug** log level. Termix loads its saved
`log_level` setting after reading `LOG_LEVEL`, so setting the environment variable
alone may not enable debug logging. Set the effective application log level to
debug before reproducing. The first two messages originate inside the WASM
module and will not appear when searching only JavaScript bundles. IronRDP's
internal Rust tracing is not connected to the worker logger; absence of those
internal messages is not evidence of a successful or failed handshake.

Compare the same target and account using the built-in engine and external
guacd, noting when PCM byte counts stop increasing. Collect timestamps, plugin
version, effective log level, audio format, byte counts, and browser audio context
state. Do not share audio payloads, credentials, or complete session recordings
without reviewing their contents.

The browser activation and late-listener fixes do not establish the cause of
issue #19's reported initial missing PCM or approximately 40-second stall on
Windows 11 LTSC. Those symptoms still require a reproduction against the affected
Windows target; local PCM playback tests are not Windows interoperability tests.
