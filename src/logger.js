import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const logFile = path.join(config.paths.logs, 'bot.log');

function writeLine(line) {
  try {
    fs.mkdirSync(config.paths.logs, { recursive: true });
    fs.appendFileSync(logFile, `${line}\n`, 'utf8');
  } catch {
    /* logging must never break the bot */
  }
}

function stamp() {
  return new Date().toISOString();
}

export const logger = {
  info(message, meta = '') {
    const line = `[${stamp()}] INFO  ${message}${meta ? ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : ''}`;
    console.log(line);
    writeLine(line);
  },
  warn(message, meta = '') {
    const line = `[${stamp()}] WARN  ${message}${meta ? ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : ''}`;
    console.warn(line);
    writeLine(line);
  },
  error(message, meta = '') {
    const line = `[${stamp()}] ERROR ${message}${meta ? ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : ''}`;
    console.error(line);
    writeLine(line);
  },
  trade(message, meta = '') {
    const line = `[${stamp()}] TRADE ${message}${meta ? ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : ''}`;
    console.log(line);
    writeLine(line);
  },
};
