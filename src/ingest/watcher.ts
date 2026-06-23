import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Store } from '../store/store.js';
import { ingestText, type IngestedRound } from './ingest.js';
import type { EloState } from '../elo/squadElo.js';

export interface WatchOptions {
  /** Poll interval in ms (how often the file size is checked). Default 1000. */
  pollMs?: number;
  /** Start from the beginning of the file instead of tailing from the end. */
  fromStart?: boolean;
  /** Max bytes to read per pump slice (bounds memory on catch-up). Default 4 MiB. */
  maxChunkBytes?: number;
  /** Called after each round is ingested. */
  onRound?: (round: IngestedRound) => void;
  /** Called for lifecycle/info messages. */
  onInfo?: (msg: string) => void;
  /**
   * Optional shared ingest function (e.g. the API server's serialized
   * `runIngest`). When provided, the watcher routes rounds through it instead of
   * managing its own Elo state — giving a single serialization point when the
   * server tails a log and also accepts HTTP pushes. When omitted (standalone
   * `npm run watch`), the watcher loads/persists Elo state itself.
   */
  ingest?: (text: string, source: string) => Promise<IngestedRound[]>;
}

/** A NEW_GAME line (map load) — not the transition map. */
function isRoundStart(line: string): boolean {
  return line.includes('LogWorld: Bringing World') && !line.includes('TransitionMap');
}

/** A round-result line, or the post-match state change — either ends a round. */
function isRoundEnd(line: string): boolean {
  return (
    line.includes('has won the match with') ||
    line.includes('Match State Changed from InProgress to WaitingPostMatch')
  );
}

/**
 * Tails a live Squad dedicated-server log file and ingests each round the moment
 * it completes. Round boundaries are detected from the same NEW_GAME / round-end
 * markers the parser uses, so only whole, finished rounds are persisted (which
 * also keeps SquadElo updates strictly in chronological order).
 *
 * Robust to log rotation/truncation: if the file shrinks, it restarts from byte 0.
 */
export class LogWatcher {
  private readonly store: Store;
  private readonly file: string;
  private readonly opts: Required<Omit<WatchOptions, 'onRound' | 'onInfo' | 'ingest'>> &
    Pick<WatchOptions, 'onRound' | 'onInfo' | 'ingest'>;
  private offset = 0;
  private remainder = '';
  private cur: string[] = [];
  private curHasStart = false;
  private curEnded = false;
  private eloState!: EloState;
  private timer: NodeJS.Timeout | null = null;
  private pumping = false;
  private stopped = false;

  constructor(file: string, store: Store, opts: WatchOptions = {}) {
    this.store = store;
    this.file = path.resolve(file);
    this.opts = {
      pollMs: opts.pollMs ?? 1000,
      fromStart: opts.fromStart ?? false,
      maxChunkBytes: opts.maxChunkBytes ?? 4 * 1024 * 1024,
      onRound: opts.onRound,
      onInfo: opts.onInfo,
      ingest: opts.ingest
    };
  }

  private info(msg: string): void {
    this.opts.onInfo?.(msg);
  }

  async start(): Promise<void> {
    await this.store.init();
    if (!this.opts.ingest) this.eloState = await this.store.loadEloState();

    // Seek to the current end unless asked to replay from the start.
    if (!this.opts.fromStart) {
      try {
        const st = await fsp.stat(this.file);
        this.offset = st.size;
      } catch {
        this.offset = 0; // file may not exist yet; we'll pick it up when created
      }
    }

    this.info(
      `Watching ${this.file} (${this.opts.fromStart ? 'from start' : 'tailing'}, poll ${this.opts.pollMs}ms). Ctrl-C to stop.`
    );
    await this.pump();
    this.timer = setInterval(() => void this.pump(), this.opts.pollMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Read whatever new bytes exist and process completed rounds. Non-reentrant. */
  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      let size: number;
      try {
        size = (await fsp.stat(this.file)).size;
      } catch {
        return; // file gone/not yet created
      }

      // rotation or truncation: start over from the top of the new file
      if (size < this.offset) {
        this.info('Log rotated/truncated — restarting from byte 0.');
        this.offset = 0;
        this.remainder = '';
      }
      if (size === this.offset) return;

      const fh = await fsp.open(this.file, 'r');
      try {
        while (this.offset < size && !this.stopped) {
          const len = Math.min(this.opts.maxChunkBytes, size - this.offset);
          const buf = Buffer.allocUnsafe(len);
          const { bytesRead } = await fh.read(buf, 0, len, this.offset);
          if (bytesRead <= 0) break;
          this.offset += bytesRead;
          await this.feed(buf.toString('utf8', 0, bytesRead));
        }
      } finally {
        await fh.close();
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Append decoded text, split into complete lines, and segment into rounds. */
  private async feed(text: string): Promise<void> {
    this.remainder += text;
    const parts = this.remainder.split(/\r?\n/);
    this.remainder = parts.pop() ?? ''; // keep trailing partial line
    for (const line of parts) {
      if (!line) continue;

      if (isRoundStart(line)) {
        // a previous round that never emitted an end marker (server crash): flush best-effort
        if (this.curHasStart && this.cur.length) await this.flush();
        this.cur = [line];
        this.curHasStart = true;
        this.curEnded = false;
        continue;
      }

      this.cur.push(line);

      if (this.curHasStart && !this.curEnded && isRoundEnd(line)) {
        this.curEnded = true;
        await this.flush();
        this.cur = [];
        this.curHasStart = false;
      }
    }
  }

  /** Ingest the current round buffer (via the shared ingest fn, or our own Elo state). */
  private async flush(): Promise<void> {
    const text = this.cur.join('\n') + '\n';
    const source = path.basename(this.file);
    try {
      let rounds: IngestedRound[];
      if (this.opts.ingest) {
        rounds = await this.opts.ingest(text, source);
      } else {
        rounds = await ingestText(text, source, this.store, this.eloState);
        if (rounds.length) await this.store.saveEloState(this.eloState);
      }
      for (const r of rounds) this.opts.onRound?.(r);
    } catch (err) {
      this.info(`Ingest error: ${String(err)}`);
    }
  }
}
