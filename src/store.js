import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Tiny JSON-file store. Writes are debounced and atomic (temp file + rename)
 * so a crash mid-write can never leave a half-written state file behind.
 */
export class Store {
  constructor(file = config.paths.stateFile) {
    this.file = file;
    this.timer = null;
    this.pending = null;
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return null;
      const raw = fs.readFileSync(this.file, 'utf8');
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    } catch (err) {
      logger.warn(`Could not read state file (${err.message}) - starting fresh`);
      return null;
    }
  }

  save(data, { immediate = false } = {}) {
    this.pending = data;
    if (immediate) {
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1500);
    this.timer.unref?.();
  }

  flush() {
    if (!this.pending) return;
    const payload = JSON.stringify(this.pending, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      logger.error(`Failed to persist state: ${err.message}`);
    } finally {
      this.pending = null;
    }
  }
}
