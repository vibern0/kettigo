import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** A local, single-writer lease. State is deliberately never cached in memory. */
export class RunState {
  private lockFd: number | undefined;
  constructor(private readonly path: string, private readonly lockPath: string) {}

  acquire(): void {
    if (this.lockFd !== undefined) throw new Error("Run state lease already acquired");
    for (const directory of [path.dirname(this.path), path.dirname(this.lockPath)]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    let fd: number;
    try { fd = openSync(this.lockPath, "wx", 0o600); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      this.removeDeadLease();
      // Exclusive creation still arbitrates if another runner wins reclamation.
      try { fd = openSync(this.lockPath, "wx", 0o600); }
      catch { throw new Error("Run state lock acquired by another runner"); }
    }
    try {
      writeFileSync(fd, String(process.pid), "utf8");
      fsyncSync(fd);
      // Keep the descriptor open so an unlinked lease's inode cannot be reused.
      this.lockFd = fd;
    } catch (error) {
      if (this.sameFile(fd)) unlinkSync(this.lockPath);
      closeSync(fd);
      throw error;
    }
  }

  read<T>(): T | null {
    this.assertOwned();
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
    return JSON.parse(text) as T;
  }

  write(value: unknown): void {
    this.assertOwned();
    const serialized = JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
    if (serialized === undefined) throw new Error("Run state must serialize to JSON");
    const temporary = path.join(path.dirname(this.path), `.${path.basename(this.path)}.${process.pid}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, serialized + "\n", "utf8");
      fsyncSync(fd); closeSync(fd); fd = undefined;
      this.assertOwned();
      renameSync(temporary, this.path);
      const directoryFd = openSync(path.dirname(this.path), "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
  }

  release(): void {
    if (this.lockFd === undefined) return;
    const fd = this.lockFd;
    try {
      if (this.ownsLease()) {
        try { unlinkSync(this.lockPath); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
      }
    } finally { closeSync(fd); this.lockFd = undefined; }
  }

  private assertOwned(): void {
    if (!this.ownsLease()) throw new Error("Run state requires its owned lock lease");
  }

  private sameFile(fd: number): boolean {
    try {
      const held = fstatSync(fd), current = statSync(this.lockPath);
      return held.dev === current.dev && held.ino === current.ino;
    } catch { return false; }
  }

  private ownsLease(): boolean {
    if (this.lockFd === undefined || !this.sameFile(this.lockFd)) return false;
    try { return readFileSync(this.lockPath, "utf8") === String(process.pid); }
    catch { return false; }
  }

  private removeDeadLease(): void {
    const fd = openSync(this.lockPath, "r");
    try {
      const text = readFileSync(fd, "utf8"), pid = Number(text);
      if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("Invalid lock PID; refusing to reclaim lease");
      }
      try { process.kill(pid, 0); }
      catch (error: any) {
        if (error.code !== "ESRCH") throw new Error("Run state lock may be active; PID permission check failed");
        if (!this.sameFile(fd) || readFileSync(this.lockPath, "utf8") !== text) {
          throw new Error("Run state lock changed during stale lease check");
        }
        unlinkSync(this.lockPath);
        return;
      }
      throw new Error("Run state lock belongs to an active PID");
    } finally { closeSync(fd); }
  }
}
