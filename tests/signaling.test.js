import { test } from "node:test";
import assert from "node:assert/strict";
import { accept, inspect, Signaling } from "../scripts/signaling.js";
import { MSG, SOCKET_CHANNEL } from "../scripts/constants.js";
import { FakeSocket } from "./helpers/foundry-stub.js";

const S = "sess1";
const listener = (over = {}) => ({
  selfId: "p1", role: "listener", activeGMId: "gm1", lock: null, live: false, sessionId: null, peers: new Set(), ...over
});
const locked = (over = {}) => listener({ lock: { senderId: "gm1", sessionId: S }, sessionId: S, ...over });
const bcast = (over = {}) => ({
  selfId: "gm1", role: "broadcaster", activeGMId: "gm1", lock: null, live: true, sessionId: S, peers: new Set(["p1"]), ...over
});

const live = (extra = {}) => ({ type: MSG.LIVE, sessionId: S, ...extra });
const offer = (extra = {}) => ({ type: MSG.OFFER, sessionId: S, sdp: "v=0", ...extra });
const answer = (extra = {}) => ({ type: MSG.ANSWER, sessionId: S, sdp: "v=0", ...extra });
const ice = (extra = {}) => ({ type: MSG.ICE, sessionId: S, candidate: { candidate: "x" }, ...extra });
const end = (extra = {}) => ({ type: MSG.END, sessionId: S, ...extra });
const request = (extra = {}) => ({ type: MSG.REQUEST, sessionId: null, ...extra });

test("malformed input is dropped", () => {
  for (const m of [null, undefined, "live", 5, [], {}, { type: "bogus" }, { type: 5 }]) {
    assert.equal(accept(m, "gm1", listener()), false, JSON.stringify(m));
    assert.equal(accept(m, "p1", bcast()), false, JSON.stringify(m));
  }
  assert.equal(accept(offer({ sdp: undefined }), "gm1", listener()), false);
  assert.equal(accept(ice({ candidate: "str" }), "gm1", locked()), false);
});

test("self-sent messages are dropped", () => {
  assert.equal(accept(live(), "p1", listener({ activeGMId: "p1" })), false);
  assert.equal(accept(request(), "gm1", bcast()), false);
});

test("messages addressed to someone else are dropped, to me or to nobody pass", () => {
  assert.equal(accept(live({ to: "p2" }), "gm1", listener()), false);
  assert.equal(accept(live({ to: "p1" }), "gm1", listener()), true);
  assert.equal(accept(live({ to: null }), "gm1", listener()), true);
  assert.equal(accept(request({ to: "someoneElse" }), "p1", bcast()), false);
  assert.equal(accept(request({ to: "gm1" }), "p1", bcast()), true);
});

test("listener: LIVE only from the active GM", () => {
  assert.equal(accept(live(), "gm1", listener()), true);
  assert.equal(accept(live(), "p2", listener()), false);
  assert.equal(accept(live(), "gm1", listener({ activeGMId: null })), false);
  assert.equal(accept(live(), "gm2", listener({ activeGMId: "gm1" })), false);
});

test("listener: OFFER from the lock holder", () => {
  assert.equal(accept(offer(), "gm1", locked()), true);
  assert.equal(accept(offer(), "p2", locked()), false);
  assert.equal(accept(offer({ sessionId: "old" }), "gm1", locked()), false);
});

test("listener: OFFER from the active GM when unlocked, and it asks to lock", () => {
  assert.equal(accept(offer(), "gm1", listener()), true);
  assert.equal(inspect(offer(), "gm1", listener()).lock, true);
  assert.equal(accept(offer(), "p2", listener()), false);
});

test("listener: OFFER from a former GM is dropped when locked to someone else", () => {
  assert.equal(accept(offer(), "gm2", locked({ activeGMId: "gm2" })), false);
});

test("listener: ICE and END need the lock holder and matching session", () => {
  for (const make of [ice, end]) {
    assert.equal(accept(make(), "gm1", locked()), true);
    assert.equal(accept(make(), "gm1", listener()), false, "no lock");
    assert.equal(accept(make(), "p2", locked()), false, "wrong sender");
    assert.equal(accept(make({ sessionId: "old" }), "gm1", locked()), false, "stale session");
    assert.equal(accept(make(), "gm9", locked({ activeGMId: "gm9" })), false, "active GM but not the lock holder");
  }
});

test("listener: everything else is dropped", () => {
  assert.equal(accept(request(), "gm1", locked()), false);
  assert.equal(accept(answer(), "gm1", locked()), false);
});

test("broadcaster: REQUEST only while live", () => {
  assert.equal(accept(request(), "p1", bcast()), true);
  assert.equal(accept(request(), "p2", bcast()), true, "any other user may request");
  assert.equal(accept(request(), "p1", bcast({ live: false })), false);
  assert.equal(accept(request({ sessionId: S }), "p1", bcast()), true);
  assert.equal(accept(request({ sessionId: "old" }), "p1", bcast()), false);
});

test("broadcaster: ANSWER and ICE only from an existing peer with the matching session", () => {
  for (const make of [answer, ice]) {
    assert.equal(accept(make(), "p1", bcast()), true);
    assert.equal(accept(make(), "p2", bcast()), false, "unknown peer");
    assert.equal(accept(make({ sessionId: "old" }), "p1", bcast()), false, "stale session");
    assert.equal(accept(make(), "p1", bcast({ live: false })), false, "not live");
  }
});

test("broadcaster: everything else is dropped", () => {
  assert.equal(accept(live(), "p1", bcast()), false);
  assert.equal(accept(offer(), "p1", bcast()), false);
  assert.equal(accept(end(), "p1", bcast()), false);
});

test("Signaling.send: broadcast without recipients, targeted with recipients and `to`", () => {
  const sock = new FakeSocket();
  const sig = new Signaling(SOCKET_CHANNEL, sock);
  sig.send(MSG.LIVE, { sessionId: S });
  sig.send(MSG.OFFER, { sessionId: S, sdp: "x" }, "p1");
  const [a, b] = sock.emitted;
  assert.equal(a.channel, SOCKET_CHANNEL);
  assert.equal(a.options, undefined);
  assert.equal(a.payload.to, null);
  assert.equal(a.payload.type, MSG.LIVE);
  assert.deepEqual(b.options, { recipients: ["p1"] });
  assert.equal(b.payload.to, "p1");
  assert.equal(b.payload.sdp, "x");
});

test("Signaling.send: a payload cannot override type or to", () => {
  const sock = new FakeSocket();
  new Signaling(SOCKET_CHANNEL, sock).send(MSG.END, { type: "offer", to: "evil" }, "p1");
  assert.equal(sock.emitted[0].payload.type, MSG.END);
  assert.equal(sock.emitted[0].payload.to, "p1");
});

test("Signaling.onMessage filters through inspect when given a ctx getter", () => {
  const sock = new FakeSocket();
  const sig = new Signaling(SOCKET_CHANNEL, sock);
  const got = [];
  sig.onMessage((m, sender, verdict) => got.push([m.type, sender, verdict.ok]), () => listener());
  sock.deliver(SOCKET_CHANNEL, live(), "gm1");
  sock.deliver(SOCKET_CHANNEL, live(), "p2");
  sock.deliver(SOCKET_CHANNEL, { nonsense: true }, "gm1");
  assert.deepEqual(got, [[MSG.LIVE, "gm1", true]]);
});

test("Signaling.onMessage without a ctx getter passes raw messages", () => {
  const sock = new FakeSocket();
  const sig = new Signaling(SOCKET_CHANNEL, sock);
  const got = [];
  sig.onMessage((m, s) => got.push([m, s]));
  sock.deliver(SOCKET_CHANNEL, { hello: 1 }, "x");
  assert.deepEqual(got, [[{ hello: 1 }, "x"]]);
});
