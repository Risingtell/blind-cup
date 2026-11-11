/**
 * Stand-in for wasm-feature-detect, which Zama's SDK uses only to ask whether WebAssembly threads exist.
 * The real package contains `import.source(...)`, a syntax current Chrome cannot parse, which stops the
 * whole page from loading. Blind Cup only decrypts, never encrypts, so it runs single-threaded.
 */
export const threads = async (): Promise<boolean> => false;
