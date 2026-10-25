// The live bank's stand-in for the `ws` package: the real WebSocket, with
// every event in and out copied to globalThis.__liveTap (esbuild aliases
// "ws" to this file).
const RealWS = require("../../node_modules/ws");

class TapWS extends RealWS {
  constructor(url, opts) {
    super(url, opts);
    this.on("message", (d) => {
      try {
        globalThis.__liveTap?.onIn(JSON.parse(String(d)));
      } catch {}
    });
  }
  send(data, ...rest) {
    try {
      globalThis.__liveTap?.onOut(JSON.parse(String(data)));
    } catch {}
    return super.send(data, ...rest);
  }
}
module.exports = TapWS;
