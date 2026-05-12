// `*.wasm` imports are resolved by wrangler's CompiledWasm rule (declared
// in wrangler.toml) and surface as a runtime `WebAssembly.Module`. TS
// doesn't ship a default declaration for this, so we provide one.
declare module '*.wasm' {
  const wasm: WebAssembly.Module;
  export default wasm;
}
