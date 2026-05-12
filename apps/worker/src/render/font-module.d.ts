// `*.ttf` imports are bundled as raw bytes by wrangler's `Data` rule
// (declared in wrangler.toml). The import returns an ArrayBuffer at
// runtime; TS needs an ambient declaration to type it.
declare module '*.ttf' {
  const font: ArrayBuffer;
  export default font;
}
