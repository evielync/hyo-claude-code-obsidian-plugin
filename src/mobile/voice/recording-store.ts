import type { DataAdapter } from "obsidian";
import { normalizePath } from "obsidian";

/**
 * Keeps every dictation on disk while it's being recorded and transcribed, so
 * a failed transcription, a closed app or a crash never costs the user what
 * they said.
 *
 * A recording is a folder inside the plugin's own directory:
 *
 *   recordings/<id>/meta.json        mime type, when it started, each piece's text
 *   recordings/<id>/s003-c0007.bin   the raw audio, written every few seconds
 *
 * A long recording is split into pieces (segments) at natural pauses, and each
 * piece is its own playable file, transcribed on its own. The audio for a piece
 * arrives from MediaRecorder as a run of chunks; joined in order they make the
 * piece's file. Writing each chunk as it arrives means a crash loses a few
 * seconds at most.
 *
 * The folder is deleted once the transcript has been handed to the chat.
 * Anything still here when Hyo next opens is a recording that never made it,
 * and the voice hook offers it back.
 */

export interface SegmentMeta {
  index: number;
  durationMs: number;
  /** null until this piece has been transcribed. */
  text: string | null;
}

export interface RecordingMeta {
  id: string;
  mimeType: string;
  createdAt: number;
  segments: SegmentMeta[];
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");

export class RecordingStore {
  private root: string;
  /** Writes for one recording run in order, so meta.json never races itself. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(private adapter: DataAdapter, pluginDir: string) {
    this.root = normalizePath(`${pluginDir}/recordings`);
  }

  private dir(id: string) {
    return `${this.root}/${id}`;
  }

  private enqueue<T>(id: string, job: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(job);
    this.queues.set(id, next);
    return next;
  }

  private async ensureDir(path: string) {
    if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
  }

  create(meta: RecordingMeta): Promise<void> {
    return this.enqueue(meta.id, async () => {
      await this.ensureDir(this.root);
      await this.ensureDir(this.dir(meta.id));
      await this.adapter.write(`${this.dir(meta.id)}/meta.json`, JSON.stringify(meta));
    });
  }

  saveMeta(meta: RecordingMeta): Promise<void> {
    const snapshot = JSON.stringify(meta);
    return this.enqueue(meta.id, () =>
      this.adapter.write(`${this.dir(meta.id)}/meta.json`, snapshot)
    );
  }

  async writeChunk(id: string, segment: number, chunk: number, data: Blob): Promise<void> {
    const buf = await data.arrayBuffer();
    return this.enqueue(id, () =>
      this.adapter.writeBinary(
        `${this.dir(id)}/s${pad(segment, 3)}-c${pad(chunk, 4)}.bin`,
        buf
      )
    );
  }

  /** The audio for one piece, rebuilt from its chunks in order. */
  async readSegment(id: string, segment: number): Promise<ArrayBuffer | null> {
    const prefix = `s${pad(segment, 3)}-c`;
    const listing = await this.adapter.list(this.dir(id));
    const files = listing.files
      .filter((f) => f.split("/").pop()!.startsWith(prefix))
      .sort();
    if (files.length === 0) return null;
    const parts = await Promise.all(files.map((f) => this.adapter.readBinary(f)));
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(new Uint8Array(p), offset);
      offset += p.byteLength;
    }
    return out.buffer;
  }

  /** Recordings left over from a session that never finished, oldest first. */
  async listUnfinished(): Promise<RecordingMeta[]> {
    if (!(await this.adapter.exists(this.root))) return [];
    const listing = await this.adapter.list(this.root);
    const out: RecordingMeta[] = [];
    for (const folder of listing.folders) {
      try {
        const raw = await this.adapter.read(`${folder}/meta.json`);
        out.push(JSON.parse(raw) as RecordingMeta);
      } catch {
        /* a folder with no readable meta has nothing we can offer back */
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  remove(id: string): Promise<void> {
    return this.enqueue(id, async () => {
      if (await this.adapter.exists(this.dir(id))) {
        await this.adapter.rmdir(this.dir(id), true);
      }
    }).finally(() => this.queues.delete(id));
  }
}
