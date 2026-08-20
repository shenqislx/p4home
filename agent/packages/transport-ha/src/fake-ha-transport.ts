import type {
  RobotHaSocket,
  RobotHaSocketFactory,
} from "./types.ts";

export class FakeRobotHaSocket implements RobotHaSocket {
  readonly #openListeners = new Set<() => void>();
  readonly #messageListeners = new Set<(frame: string, binary: boolean) => void>();
  readonly #closeListeners = new Set<(code: number, reason: string) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  readonly sent_frames: string[] = [];
  #open = false;
  #closed = false;

  public get is_open(): boolean {
    return this.#open && !this.#closed;
  }

  public send(frame: string): void {
    if (!this.is_open) {
      throw new Error("fake Home Assistant socket is not open");
    }
    this.sent_frames.push(frame);
  }

  public close(code = 1000, reason = "client close"): void {
    this.serverClose(code, reason);
  }

  public terminate(): void {
    this.serverClose(1006, "client terminate");
  }

  public onOpen(listener: () => void): () => void {
    this.#openListeners.add(listener);
    return () => this.#openListeners.delete(listener);
  }

  public onMessage(listener: (frame: string, binary: boolean) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  public onClose(listener: (code: number, reason: string) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  public onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  public serverOpen(): void {
    if (this.#closed || this.#open) {
      throw new Error("fake Home Assistant socket cannot be opened");
    }
    this.#open = true;
    for (const listener of this.#openListeners) {
      listener();
    }
  }

  public serverSend(message: unknown, binary = false): void {
    if (!this.is_open) {
      throw new Error("fake Home Assistant socket is not open");
    }
    const frame = typeof message === "string" ? message : JSON.stringify(message);
    for (const listener of this.#messageListeners) {
      listener(frame, binary);
    }
  }

  public serverError(error: Error): void {
    for (const listener of this.#errorListeners) {
      listener(error);
    }
  }

  public serverClose(code = 1006, reason = "server close"): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#open = false;
    for (const listener of this.#closeListeners) {
      listener(code, reason);
    }
  }
}

export class FakeRobotHaSocketFactory {
  readonly sockets: FakeRobotHaSocket[] = [];
  readonly urls: string[] = [];

  public readonly create: RobotHaSocketFactory = (url) => {
    const socket = new FakeRobotHaSocket();
    this.urls.push(url);
    this.sockets.push(socket);
    return socket;
  };
}
