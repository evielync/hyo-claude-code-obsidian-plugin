import { App, Notice, requestUrl } from "obsidian";

/**
 * First-run voice-model download.
 *
 * The Silero VAD + Smart Turn models and the onnxruntime wasm (~50MB) are too
 * big to ship with the plugin (BRAT/the store carry only main.js, manifest,
 * styles). So on first use of voice mode we fetch them from a fixed GitHub
 * release into the plugin's own `vad-assets/` folder — the exact path the
 * loaders already read. In the dev sandbox the files are already there (repo),
 * so nothing downloads. One-time; cached forever after.
 */

const RELEASE_BASE =
  "https://github.com/evielync/hyo-claude-code-obsidian-plugin/releases/download/voice-models";

// local path (under vad-assets/) → flat asset name in the release (GitHub
// release asset names can't contain slashes).
const ASSETS: { local: string; asset: string }[] = [
  { local: "silero_vad_v5.onnx", asset: "silero_vad_v5.onnx" },
  { local: "vad.worklet.bundle.min.js", asset: "vad.worklet.bundle.min.js" },
  { local: "ort-wasm-simd-threaded.wasm", asset: "ort-wasm-simd-threaded.wasm" },
  { local: "ort-wasm-simd-threaded.mjs", asset: "ort-wasm-simd-threaded.mjs" },
  {
    local: "ort-wasm-simd-threaded.jsep.wasm",
    asset: "ort-wasm-simd-threaded.jsep.wasm",
  },
  {
    local: "ort-wasm-simd-threaded.jsep.mjs",
    asset: "ort-wasm-simd-threaded.jsep.mjs",
  },
  {
    local: "models/onnx-community/smart-turn-v3-ONNX/onnx/model_quantized.onnx",
    asset: "smart-turn-model_quantized.onnx",
  },
];

async function ensureDir(app: App, dir: string): Promise<void> {
  const adapter = app.vault.adapter;
  const parts = dir.split("/");
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    if (!(await adapter.exists(cur))) {
      try {
        await adapter.mkdir(cur);
      } catch {
        /* already exists / race — fine */
      }
    }
  }
}

/**
 * Ensure the voice model assets exist locally, downloading any that are
 * missing. Throws if a download fails. `pluginDir` is the plugin's
 * vault-relative folder (`manifest.dir`).
 */
export async function ensureVoiceAssets(
  app: App,
  pluginDir: string
): Promise<void> {
  const adapter = app.vault.adapter;
  const base = `${pluginDir}/vad-assets`;

  const missing: typeof ASSETS = [];
  for (const a of ASSETS) {
    if (!(await adapter.exists(`${base}/${a.local}`))) missing.push(a);
  }
  if (missing.length === 0) return;

  const notice = new Notice("Setting up voice — downloading models (one-time, ~50MB)…", 0);
  try {
    let done = 0;
    for (const a of missing) {
      done++;
      notice.setMessage(
        `Setting up voice — downloading models… (${done}/${missing.length})`
      );
      const res = await requestUrl({
        url: `${RELEASE_BASE}/${a.asset}`,
        method: "GET",
      });
      if (res.status !== 200) {
        throw new Error(`${a.asset}: HTTP ${res.status}`);
      }
      const localPath = `${base}/${a.local}`;
      const parent = localPath.slice(0, localPath.lastIndexOf("/"));
      await ensureDir(app, parent);
      await adapter.writeBinary(localPath, res.arrayBuffer);
    }
    notice.setMessage("Voice is ready.");
    setTimeout(() => notice.hide(), 2500);
  } catch (err) {
    notice.hide();
    throw err;
  }
}
