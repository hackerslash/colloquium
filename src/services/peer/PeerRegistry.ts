import Peer, { type DataConnection } from "peerjs";
import { ICE_SERVERS } from "./iceServers";
import { derivePeerId } from "./derivePeerId";

type PeerRegistryEvents = {
  ready: [];
  "broker-up": [];
  "broker-down": [];
  "peer-connected": [peerId: string];
  "peer-disconnected": [peerId: string];
  "dial-failed": [peerId: string];
  message: [peerId: string, data: unknown];
  error: [error: unknown];
};

type Listener<E extends keyof PeerRegistryEvents> = (
  ...args: PeerRegistryEvents[E]
) => void;

const MAX_ID_SUFFIX_ATTEMPTS = 5;
const CONNECT_TIMEOUT_MS = 10_000;
const BROKER_BACKOFF_BASE_MS = 1_000;
const BROKER_BACKOFF_MAX_MS = 30_000;
const DIAL_BACKOFF_BASE_MS = 2_000;
const DIAL_BACKOFF_MAX_MS = 60_000;
const PING_INTERVAL_MS = 4_000;
const LIVENESS_TIMEOUT_MS = 10_000;

function jittered(ms: number): number {
  return ms * (0.8 + 0.4 * Math.random());
}

/**
 * Wraps a PeerJS `Peer` purely as a signaling/data transport. Connections
 * here carry app control messages (invites, roster gossip, presence) — media
 * rides a separate raw RTCPeerConnection layer with perfect negotiation.
 *
 * Liveness is app-level: pings ride every open connection and a peer silent
 * past LIVENESS_TIMEOUT_MS is closed, because WebRTC data channels can stay
 * "open" for minutes after an abrupt disconnect. Dials back off exponentially
 * per peer, and both sides of a pair dial (glare is resolved deterministically
 * in favor of the connection dialed by the lexicographically smaller peer id).
 */
export class PeerRegistry {
  private peer: Peer | null = null;
  private connections = new Map<string, DataConnection>();
  private listeners = new Map<keyof PeerRegistryEvents, Set<Listener<any>>>();
  private readonly selfPeerId: string;
  /** Peers we are currently dialing — prevents stacking multiple awaitOpen
   * timers when discover() fires again before the first attempt resolves. */
  private dialing = new Map<string, Promise<DataConnection>>();
  /** Connections this side dialed (vs inbound) — used for glare resolution. */
  private outbound = new WeakSet<DataConnection>();
  /** Peers currently "up" — gates connect/disconnect events so a replaced
   * physical connection doesn't flap presence. */
  private up = new Set<string>();
  private lastSeenAt = new Map<string, number>();
  private lastPingAt = new Map<string, number>();
  private dialBackoff = new Map<string, { failures: number; nextAttemptAt: number }>();
  private brokerAttempts = 0;
  private brokerReconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
    let openedOnce = false;

    peer.on("connection", (conn) => this.registerConnection(conn));

    // Fires on initial registration and again after every reconnect().
    peer.on("open", (id) => {
      this.brokerAttempts = 0;
      if (!openedOnce) {
        openedOnce = true;
        this.emit("ready");
        resolve(id);
      }
      this.emit("broker-up");
    });

    peer.on("error", (err: { type?: string } & Error) => {
      if (err.type === "unavailable-id" && suffix < MAX_ID_SUFFIX_ATTEMPTS) {
        peer.destroy();
        this.registerWithBroker(suffix + 1, resolve, reject);
        return;
      }
      this.emit("error", err);
      if (!openedOnce) reject(err);
      // Fatal broker errors (server-error/socket-error/network, or id-suffix
      // attempts exhausted) can destroy the underlying Peer. A destroyed
      // Peer's reconnect() is a permanent no-op, so without recreating it
      // here the device stays signaling-dead until the app is restarted.
      if (this.peer === peer && peer.destroyed) {
        this.scheduleBrokerRecovery(() => this.registerWithBroker(0, () => {}, () => {}));
      }
    });

    peer.on("disconnected", () => {
      this.scheduleBrokerRecovery(() => {
        if (this.peer === peer && !peer.destroyed && peer.disconnected) peer.reconnect();
      });
    });
  }

  /** Shared backoff for both plain broker disconnects (reconnect() suffices)
   * and fatal errors that destroy the Peer (need a fresh one recreated). */
  private scheduleBrokerRecovery(attempt: () => void) {
    this.emit("broker-down");
    const delay = jittered(
      Math.min(BROKER_BACKOFF_MAX_MS, BROKER_BACKOFF_BASE_MS * 2 ** this.brokerAttempts),
    );
    this.brokerAttempts++;
    if (this.brokerReconnectTimer) clearTimeout(this.brokerReconnectTimer);
    this.brokerReconnectTimer = setTimeout(attempt, delay);
  }

  private registerConnection(conn: DataConnection) {
    const existing = this.connections.get(conn.peer);
    if (existing === conn) return;
    // With no incumbent this conn takes the slot immediately; otherwise it
    // stays an unmapped challenger and adoption is decided when it opens.
    if (!existing) this.connections.set(conn.peer, conn);

    conn.on("data", (data) => this.handleData(conn, data));
    conn.on("open", () => this.handleOpen(conn));
    conn.on("close", () => this.handleClose(conn));
    conn.on("error", (err) => this.emit("error", err));
  }

  /** Glare rule: both sides dial, and both keep the connection dialed by the
   * lexicographically smaller peer id — a deterministic pick that needs no
   * extra round trips and agrees on both ends. */
  private challengerWins(challenger: DataConnection): boolean {
    const preferOutbound = this.selfPeerId < challenger.peer;
    return this.outbound.has(challenger) === preferOutbound;
  }

  private handleOpen(conn: DataConnection) {
    const mapped = this.connections.get(conn.peer);
    if (mapped !== conn) {
      if (mapped?.open && !this.challengerWins(conn)) {
        conn.close();
        return;
      }
      // Either the incumbent never opened (dead dial) or it lost the glare
      // pick — supersede it. Its close stays silent since it's unmapped.
      this.connections.set(conn.peer, conn);
      mapped?.close();
    }
    this.lastSeenAt.set(conn.peer, Date.now());
    this.dialBackoff.delete(conn.peer);
    if (!this.up.has(conn.peer)) {
      this.up.add(conn.peer);
      this.emit("peer-connected", conn.peer);
    }
  }

  private handleClose(conn: DataConnection) {
    if (this.connections.get(conn.peer) !== conn) return; // superseded duplicate
    this.dropPeer(conn.peer);
  }

  private dropPeer(peerId: string) {
    this.connections.delete(peerId);
    this.lastSeenAt.delete(peerId);
    this.lastPingAt.delete(peerId);
    if (this.up.has(peerId)) {
      this.up.delete(peerId);
      this.emit("peer-disconnected", peerId);
    }
  }

  private handleData(conn: DataConnection, data: unknown) {
    this.lastSeenAt.set(conn.peer, Date.now());
    const type = (data as { type?: string } | null)?.type;
    if (type === "ping") {
      if (conn.open) conn.send({ type: "pong", ts: Date.now() });
      return;
    }
    if (type === "pong") return;
    this.emit("message", conn.peer, data);
  }

  private awaitOpen(conn: DataConnection): Promise<DataConnection> {
    if (conn.open) return Promise.resolve(conn);
    return new Promise((resolve, reject) => {
      const fail = (err: unknown) => {
        clearTimeout(timeout);
        // A conn that never opened fires no `close` event, so clean it up
        // explicitly — otherwise the map keeps a dead entry that can never
        // open and every future dial reuses it (the eternal-"connecting" bug).
        if (this.connections.get(conn.peer) === conn) this.connections.delete(conn.peer);
        conn.close();
        reject(err);
      };
      const timeout = setTimeout(
        () => fail(new Error(`connect to ${conn.peer} timed out`)),
        CONNECT_TIMEOUT_MS,
      );
      conn.once("open", () => {
        clearTimeout(timeout);
        resolve(conn);
      });
      conn.once("error", fail);
    });
  }

  /** Whether a dial to this peer is allowed right now (exponential backoff
   * with jitter after failures; reset on any successful open). */
  canDial(peerId: string, now = Date.now()): boolean {
    const state = this.dialBackoff.get(peerId);
    return !state || now >= state.nextAttemptAt;
  }

  private recordDialFailure(peerId: string) {
    const failures = (this.dialBackoff.get(peerId)?.failures ?? 0) + 1;
    const delay = jittered(
      Math.min(DIAL_BACKOFF_MAX_MS, DIAL_BACKOFF_BASE_MS * 2 ** (failures - 1)),
    );
    this.dialBackoff.set(peerId, { failures, nextAttemptAt: Date.now() + delay });
  }

  connect(peerId: string): Promise<DataConnection> {
    const existing = this.connections.get(peerId);
    if (existing?.open) return Promise.resolve(existing);

    // Return the in-progress dial promise rather than stacking a new awaitOpen
    // timeout on every discover() tick.
    const inflight = this.dialing.get(peerId);
    if (inflight) return inflight;

    if (!this.peer || this.peer.destroyed) {
      return Promise.reject(new Error("peer registry not started"));
    }
    if (this.peer.disconnected) {
      return Promise.reject(new Error("broker connection is down"));
    }
    if (!this.canDial(peerId)) {
      return Promise.reject(new Error(`dial to ${peerId} is backing off`));
    }

    let conn: DataConnection;
    if (existing && !this.outbound.has(existing)) {
      // A pending inbound connection is already underway — await it instead
      // of racing a competing outbound dial against it.
      conn = existing;
    } else {
      // Never reuse a non-open outbound conn: a dial that timed out can never
      // open. Close it and dial fresh.
      if (existing) {
        this.connections.delete(peerId);
        existing.close();
      }
      conn = this.peer.connect(peerId, { reliable: true });
      this.outbound.add(conn);
      this.registerConnection(conn);
    }

    const attempt = this.awaitOpen(conn)
      .catch((err) => {
        this.recordDialFailure(peerId);
        this.emit("dial-failed", peerId);
        throw err;
      })
      .finally(() => {
        this.dialing.delete(peerId);
      });
    this.dialing.set(peerId, attempt);
    return attempt;
  }

  /** Sends pings on quiet connections and kills any that have gone silent
   * past the liveness timeout. Call on a short interval (the discovery tick). */
  heartbeatTick(now = Date.now()) {
    for (const [peerId, conn] of this.connections) {
      if (!conn.open) continue;
      const seen = this.lastSeenAt.get(peerId) ?? now;
      if (now - seen > LIVENESS_TIMEOUT_MS) {
        // Clean up deterministically first — close() event timing varies.
        this.dropPeer(peerId);
        conn.close();
        continue;
      }
      if (now - (this.lastPingAt.get(peerId) ?? 0) >= PING_INTERVAL_MS) {
        this.lastPingAt.set(peerId, now);
        try {
          conn.send({ type: "ping", ts: now });
        } catch {
          // send failure means the channel is dying; liveness will reap it
        }
      }
    }
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
    if (this.brokerReconnectTimer) clearTimeout(this.brokerReconnectTimer);
    this.brokerReconnectTimer = null;
    this.connections.forEach((conn) => conn.close());
    this.connections.clear();
    this.up.clear();
    this.lastSeenAt.clear();
    this.lastPingAt.clear();
    this.dialBackoff.clear();
    this.peer?.destroy();
    this.peer = null;
  }
}
