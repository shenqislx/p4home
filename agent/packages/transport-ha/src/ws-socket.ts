import WebSocket from "ws";

import type {
  RobotHaSocket,
  RobotHaSocketFactory,
} from "./types.ts";

class WsRobotHaSocket implements RobotHaSocket {
  readonly #socket: WebSocket;

  public constructor(url: string, maxFrameBytes: number) {
    this.#socket = new WebSocket(url, {
      maxPayload: maxFrameBytes,
      perMessageDeflate: false,
    });
  }

  public get is_open(): boolean {
    return this.#socket.readyState === WebSocket.OPEN;
  }

  public send(frame: string): void {
    this.#socket.send(frame, { binary: false });
  }

  public close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }

  public terminate(): void {
    this.#socket.terminate();
  }

  public onOpen(listener: () => void): () => void {
    this.#socket.on("open", listener);
    return () => this.#socket.off("open", listener);
  }

  public onMessage(listener: (frame: string, binary: boolean) => void): () => void {
    const wrapped = (data: WebSocket.RawData, binary: boolean): void => {
      listener(typeof data === "string" ? data : data.toString("utf8"), binary);
    };
    this.#socket.on("message", wrapped);
    return () => this.#socket.off("message", wrapped);
  }

  public onClose(listener: (code: number, reason: string) => void): () => void {
    const wrapped = (code: number, reason: Buffer): void => listener(code, reason.toString("utf8"));
    this.#socket.on("close", wrapped);
    return () => this.#socket.off("close", wrapped);
  }

  public onError(listener: (error: Error) => void): () => void {
    this.#socket.on("error", listener);
    return () => this.#socket.off("error", listener);
  }
}

export const createRobotHaWebSocket: RobotHaSocketFactory = (url, maxFrameBytes) =>
  new WsRobotHaSocket(url, maxFrameBytes);
