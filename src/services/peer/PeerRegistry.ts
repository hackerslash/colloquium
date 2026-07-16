import Peer, { type DataConnection } from "peerjs";
import { ICE_SERVERS } from "./iceServers";
import { derivePeerId } from "./derivePeerId";

type PeerRegistryEvents = {
  ready: [];
  "peer-connected": [peerId: string];
  "peer-disconnected": [peerId: string];
  message: [peerId: string, data: unknown];
  error: [error: unknown];
};

type Listener<E extends keyof PeerRegistryEvents> = (
  ...args: PeerRegistryEvents[E]
) => void;

const MAX_ID_SUFFIX_ATTEMPTS = 5;
const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 2_000;

/**
 * Wraps a PeerJS `Peer` purely as a signaling/data transport. Connections
 * here carry app control messages (invites, roster gossip, presence) —
 * Phase 3+ introduces a separate raw RTCPeerConnection layer with perfect
 * negotiation for media, since renegotiating tracks needs control this
 * wrapper deliberately doesn't try to provide.
 */
export class PeerRegistry {
  private peer: Peer | null = null;
  private connections = new Map<string, DataConnection>();
  private listeners = new Map<keyof PeerRegistryEvents, Set<Listener<any>>>();
  private readonly selfPeerId: string;

  constructor(selfIdentityId: string) {
    this.selfPeerId = derivePeerId(selfIdentityId);
  }

  get id(): string {
    return this.selfPeerId;
  }

  on<E extends keyof PeerRegistryEvents>(event: E, listener: Listener<E>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  private emit<E extends keyof PeerRegistryEvents>(
    event: E,
    ...args: PeerRegistryEvents[E]
  ) {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.registerWithBroker(0, resolve, reject);
    });
  }

  private registerWithBroker(
    suffix: number,
    resolve: (id: string) => void,
    reject: (err: unknown) => void,
  ) {
    const candidateId =
      suffix === 0 ? this.selfPeerId : `${this.selfPeerId}-${suffix + 1}`;
    const peer = new Peer(candidateId, { config: { iceServers: ICE_SERVERS } });
    this.peer = peer;

    peer.on("open", (id) => {
      peer.on("connection", (conn) => this.registerConnection(conn));
      this.emit("ready");
      resolve(id);
    });

    peer.on("error", (err: { type?: string } & Error) => {
      if (err.type === "unavailable-id" && suffix < MAX_ID_SUFFIX_ATTEMPTS) {
        peer.destroy();
        this.registerWithBroker(suffix + 1, resolve, reject);
        return;
      }
      this.emit("error", err);
      reject(err);
    });

    peer.on("disconnected", () => {
      setTimeout(() => {
        if (this.peer === peer && !peer.destroyed) peer.reconnect();
      }, RECONNECT_DELAY_MS);
    });
  }

  private registerConnection(conn: DataConnection) {
    const existing = this.connections.get(conn.peer);
    if (existing && existing !== conn && existing.open && !conn.open) {
      conn.close();
      return;
    }

    this.connections.set(conn.peer, conn);
    conn.on("data", (data) => this.emit("message", conn.peer, data));
    conn.on("open", () => this.emit("peer-connected", conn.peer));
    conn.on("close", () => {
      if (this.connections.get(conn.peer) === conn) {
        this.connections.delete(conn.peer);
      }
      this.emit("peer-disconnected", conn.peer);
    });
    conn.on("error", (err) => this.emit("error", err));
  }

  private awaitOpen(conn: DataConnection): Promise<DataConnection> {
    if (conn.open) return Promise.resolve(conn);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`connect to ${conn.peer} timed out`)),
        CONNECT_TIMEOUT_MS,
      );
      conn.once("open", () => {
        clearTimeout(timeout);
        resolve(conn);
      });
      conn.once("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  connect(peerId: string): Promise<DataConnection> {
    const existing = this.connections.get(peerId);
    if (existing) {
      return existing.open ? Promise.resolve(existing) : this.awaitOpen(existing);
    }
    if (!this.peer) return Promise.reject(new Error("peer registry not started"));

    const conn = this.peer.connect(peerId, { reliable: true });
    this.registerConnection(conn);
    return this.awaitOpen(conn);
  }

  send(peerId: string, data: unknown): boolean {
    const conn = this.connections.get(peerId);
    if (!conn?.open) return false;
    conn.send(data);
    return true;
  }

  isConnected(peerId: string): boolean {
    return this.connections.get(peerId)?.open ?? false;
  }

  stop() {
    this.connections.forEach((conn) => conn.close());
    this.connections.clear();
    this.peer?.destroy();
    this.peer = null;
  }
}
