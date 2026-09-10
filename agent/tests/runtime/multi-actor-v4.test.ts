import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMultiActorDeviceMessage } from '@p4home/contracts';
import { MultiActorDeviceConnection, HUMAN_DEVICE_TOOLS, CAT_DEVICE_TOOLS } from '../../apps/runtime/src/multi-actor-device-runtime.ts';
import { decodeDeviceMessage } from '../../apps/runtime/src/device-protocol.ts';
import type { DeviceWebSocketConnection } from '../../apps/runtime/src/device-action-adapter.ts';
class Wire implements DeviceWebSocketConnection {
    is_open = true;
    sent: any[] = [];
    closed: number | null = null;
    frames = new Set<(s: string) => void>();
    closes = new Set<() => void>();
    async send(s: string) { this.sent.push(JSON.parse(s)); }
    close(c: number) { this.closed = c; this.is_open = false; for (const f of this.closes)
        f(); }
    onFrame(f: (s: string) => void) { this.frames.add(f); return () => this.frames.delete(f); }
    onClose(f: () => void) { this.closes.add(f); return () => this.closes.delete(f); }
    receive(m: unknown) { for (const f of this.frames)
        f(JSON.stringify(m)); }
}
const rooms = ['primary_bedroom', 'study', 'guest_room', 'entry', 'living_room', 'kitchen'];
const objects = [['living_room.sofa', 'living_room', ['go_to', 'sit', 'look_at', 'interact']], ['study.desk', 'study', ['go_to', 'look_at', 'interact']], ['living_room.window', 'living_room', ['go_to', 'look_at', 'interact']]].map(([object_id, room_id, supported_actions]) => ({ object_id, room_id, supported_actions, available: true }));
function state(): any { return { snapshot_id: 'snapshot-1', reason: 'connect', world_version: 1, observed_at_ms: 1000, actors: ['human_avatar', 'cat'].map(actor_id => ({ actor_id, state_version: 1, room_id: 'living_room', activity: 'idle', speaking: false, active_action_id: null, target_object_id: null, pose: 'standing' })), objects: objects.map(({ supported_actions, ...o }) => ({ ...o, occupied_by_actor_id: null })) }; }
function fixture() {
    const wire = new Wire(), runtime = new MultiActorDeviceConnection('device-1', wire);
    let seq = 0;
    const message = (type: string, payload: Record<string, unknown>, correlation_id: string | null = null) => ({ protocol_version: 4, message_id: `message-${seq}`, correlation_id, device_id: 'device-1', session_id: 'boot-1', seq: seq++, sent_at_ms: 1000, type, payload });
    const send = (type: string, payload: Record<string, unknown>, correlation: string | null = null) => wire.receive(message(type, payload, correlation));
    const handshake = () => { send('device.hello', { boot_id: 'boot-1', firmware_version: 'test', protocol_versions: [4], connection_reason: 'boot' }); send('device.capabilities', { selected_protocol_version: 4, rooms, objects, actors: [{ actor_id: 'human_avatar', actions: HUMAN_DEVICE_TOOLS }, { actor_id: 'cat', actions: CAT_DEVICE_TOOLS }], limits: { max_json_frame_bytes: 16384, action_queue_capacity: 8, say_text_max_chars: 256, action_timeout_min_ms: 100, action_timeout_max_ms: 120000, idempotency_retention_ms: 600000, actor_capacity: 2, cat_queue_capacity: 2 } }); send('world.snapshot', state()); assert.equal(runtime.is_ready, true, runtime.last_error?.stack); };
    return { wire, runtime, message, send, handshake };
}
const spec = (id: string) => ({ action_id: id, tool: 'character.go_to_room' as const, arguments: { room_id: 'study' }, timeout_ms: 1000 });
const tick = () => new Promise<void>(r => setImmediate(r));
test('v4 validates whole-world ownership, ordering, bounds and frozen legacy rejection', () => { const f = fixture(), m = f.message('world.snapshot', state()); validateMultiActorDeviceMessage(m); assert.throws(() => decodeDeviceMessage(JSON.stringify(m))); for (const mutate of [(s: any) => s.actors.reverse(), (s: any) => s.actors.pop(), (s: any) => { s.actors[1].pose = 'sitting'; s.actors[1].target_object_id = 'living_room.sofa'; }, (s: any) => { s.objects[0].occupied_by_actor_id = 'cat'; }, (s: any) => { s.actors[0].speaking = s.actors[1].speaking = true; }, (s: any) => { s.actors[0].art_x = 10; }]) {
    const s = state();
    mutate(s);
    assert.throws(() => validateMultiActorDeviceMessage({ ...m, payload: s }));
} });
test('v4 wire sequence and actor capabilities, world and terminal results stay isolated', async () => { const f = fixture(); f.handshake(); const human = f.runtime.getAdapter('human_avatar'), cat = f.runtime.getAdapter('cat'); assert.deepEqual(human.action_capabilities, HUMAN_DEVICE_TOOLS); assert.deepEqual(cat.action_capabilities, CAT_DEVICE_TOOLS); const a = human.executeAction(spec('human-1')), b = cat.executeAction({ ...spec('cat-1'), origin: 'autonomy' }); await tick(); assert.deepEqual(f.wire.sent.map(m => [m.protocol_version, m.seq, m.payload.actor_id]), [[4, 0, 'human_avatar'], [4, 1, 'cat']]); f.send('action.completed', { action_id: 'cat-1', actor_id: 'cat', tool: 'character.go_to_room', completed_at_ms: 1001, actor_state_version: 2, world_version: 2, result: { room_id: 'study' } }); assert.equal((await b).status, 'completed'); assert.equal(human.pending_waiters, 1); f.send('action.failed', { action_id: 'human-1', actor_id: 'human_avatar', failed_at_ms: 1002, error: { code: 'CANCELLED', message: 'cancelled', retryable: false } }); assert.equal((await a).status, 'failed'); const s = state(); s.world_version = 2; s.actors[1].state_version = 2; s.actors[1].room_id = 'study'; const { snapshot_id, reason, ...changed } = s; f.send('world.changed', { ...changed, change_reason: 'action' }); assert.equal(cat.last_snapshot?.character.room_id, 'study'); assert.equal(human.last_snapshot?.character.room_id, 'living_room'); assert.equal(f.wire.closed, null); f.wire.close(1000); });
test('v4 cross-actor lifecycle closes transport and leaves action unknown', async () => { const f = fixture(); f.handshake(); const p = f.runtime.getAdapter('human_avatar').executeAction(spec('human-1')); await tick(); f.send('action.started', { action_id: 'human-1', actor_id: 'cat', started_at_ms: 1000 }); assert.equal(f.wire.closed, 1002); assert.equal((await p).status, 'unknown'); assert.equal(f.runtime.is_ready, false); });
test('v4 sequence gap blocks both actors until correlated full resync', async () => { const f = fixture(); f.handshake(); f.message('heartbeat', {}); f.send('heartbeat', { uptime_ms: 1000, last_rx_seq: 0, state_version: 1 }); await tick(); assert.equal(f.runtime.is_ready, false); const requests = f.wire.sent.filter(m => m.type === 'world.resync.request'); assert.equal(requests.length, 1); f.send('world.snapshot', { ...state(), reason: 'resync' }, 'wrong-request'); assert.equal(f.runtime.is_ready, false); f.send('world.snapshot', { ...state(), reason: 'resync' }, requests[0].message_id); assert.equal(f.runtime.is_ready, true, f.runtime.last_error?.stack); f.wire.close(1000); });
test('v4 global duplicate IDs and forbidden Cat user origin cannot dispatch', async () => { const f = fixture(); f.handshake(); const a = f.runtime.getAdapter('human_avatar').executeAction(spec('shared-1')); await tick(); const b = await f.runtime.getAdapter('cat').executeAction({ ...spec('shared-1'), origin: 'autonomy' }); assert.notEqual(b.status, 'completed'); assert.equal(f.wire.sent.filter(m => m.type === 'action.request').length, 1); f.wire.close(1000); assert.equal((await a).status, 'unknown'); assert.throws(() => validateMultiActorDeviceMessage(f.message('action.request', { ...spec('bad'), actor_id: 'cat', origin: 'user' }))); });
test('v4 shared sofa permits one standing observer and one seated owner without corrupting projections', () => { const f = fixture(); f.handshake(); const s = state(); s.world_version = 4; s.actors[0].state_version = 2; s.actors[1].state_version = 3; for (const a of s.actors)
    a.target_object_id = 'living_room.sofa'; s.actors[1].pose = 'sitting'; s.objects[0].occupied_by_actor_id = 'cat'; f.send('world.snapshot', { ...s, reason: 'requested' }); assert.equal(f.runtime.is_ready, true, f.runtime.last_error?.stack); const hs = f.runtime.getAdapter('human_avatar').last_snapshot?.character, cs = f.runtime.getAdapter('cat').last_snapshot?.character; assert.ok(hs && 'pose' in hs && cs && 'pose' in cs); assert.equal(hs.pose, 'standing'); assert.equal(cs.pose, 'sitting'); assert.equal(f.runtime.getAdapter('human_avatar').last_snapshot?.objects?.[0]?.occupied, true); f.wire.close(1000); });
test('v4 disconnect and reconnect reconcile per actor without replaying unknown actions', async () => { const f = fixture(); f.handshake(); const action = f.runtime.getAdapter('cat').executeAction({ ...spec('cat-unknown'), origin: 'autonomy' }); await tick(); f.wire.close(1000); assert.equal((await action).status, 'unknown'); const sent = f.wire.sent.length; f.wire.is_open = true; const reboot = (seq: number, type: string, payload: any) => f.wire.receive({ protocol_version: 4, message_id: `reboot-${seq}`, correlation_id: null, device_id: 'device-1', session_id: 'boot-2', seq, sent_at_ms: 2000, type, payload }); reboot(0, 'device.hello', { boot_id: 'boot-2', firmware_version: 'test', protocol_versions: [4], connection_reason: 'reconnect' }); reboot(1, 'device.capabilities', { selected_protocol_version: 4, rooms, objects, actors: [{ actor_id: 'human_avatar', actions: HUMAN_DEVICE_TOOLS }, { actor_id: 'cat', actions: CAT_DEVICE_TOOLS }], limits: { max_json_frame_bytes: 16384, action_queue_capacity: 8, say_text_max_chars: 256, action_timeout_min_ms: 100, action_timeout_max_ms: 120000, idempotency_retention_ms: 600000, actor_capacity: 2, cat_queue_capacity: 2 } }); const s = state(); s.reason = 'reconnect'; s.actors[1].room_id = 'study'; s.actors[1].state_version = 3; s.world_version = 3; reboot(2, 'world.snapshot', s); assert.equal(f.runtime.is_ready, true, f.runtime.last_error?.stack); assert.equal(f.wire.sent.length, sent); assert.equal(f.runtime.getAdapter('human_avatar').last_snapshot?.character.room_id, 'living_room'); assert.equal(f.runtime.getAdapter('cat').getAction('cat-unknown')?.status, 'unknown'); f.wire.close(1000); });

test('v4 unchanged state tolerates JSON property order but rejects unversioned changes', () => {
    const f = fixture();
    f.handshake();
    const snapshot = state();
    snapshot.actors = snapshot.actors.map((actor: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(actor).reverse()));
    snapshot.objects = snapshot.objects.map((object: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(object).reverse()));
    f.send('world.snapshot', { ...snapshot, reason: 'requested' });
    assert.equal(f.runtime.is_ready, true, f.runtime.last_error?.stack);
    snapshot.actors[1].room_id = 'study';
    f.send('world.snapshot', { ...snapshot, reason: 'requested' });
    assert.equal(f.wire.closed, 1002);
    assert.equal(f.runtime.is_ready, false);
});
