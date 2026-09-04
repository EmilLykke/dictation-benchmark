import { existsSync } from "node:fs";

interface BridgeResponse {
  id: number;
  ok: boolean;
  error?: string;
  result?: unknown;
}

export class NativeBridge {
  private readonly process: Bun.Subprocess<"pipe", "pipe", "inherit">;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private closed = false;

  constructor(executablePath: string) {
    if (!existsSync(executablePath)) {
      throw new Error(
        `Native bridge missing: ${executablePath}\nRun: bun run build:native`,
      );
    }
    this.process = Bun.spawn([executablePath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    void this.readResponses();
    void this.watchExit();
  }

  async request<T>(command: Record<string, unknown>): Promise<T> {
    if (this.closed) throw new Error("Native bridge is closed");
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.process.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    await this.process.stdin.flush();
    return promise;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request({ command: "quit" });
    } finally {
      this.closed = true;
      this.process.stdin.end();
      await this.process.exited;
    }
  }

  private async readResponses(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleResponse(JSON.parse(line) as BridgeResponse);
      }
    }
  }

  private handleResponse(response: BridgeResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (!response.ok) pending.reject(new Error(response.error ?? "Native bridge failed"));
    else pending.resolve(response.result);
  }

  private async watchExit(): Promise<void> {
    const exitCode = await this.process.exited;
    if (this.closed) return;
    this.closed = true;
    const error = new Error(`Native bridge exited unexpectedly (${exitCode})`);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

