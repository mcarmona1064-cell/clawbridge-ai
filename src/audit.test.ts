import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { audit, exportAudit, readAudit, verifyAuditChain } from './audit.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createUserLink, removeUserLink } from './db/user-links.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { upsertUser } from './modules/permissions/db/users.js';

describe('audit log', () => {
  beforeEach(() => runMigrations(initTestDb()));
  afterEach(() => closeDb());

  it('appends rows with a hash chain that verifies', () => {
    audit('approval.decided', { actor: 'slack:U1', target: 'appr-1', detail: { decision: 'approved' } });
    audit('message.posted', { target: 'm-1', channelType: 'whatsapp' });
    const rows = readAudit();
    expect(rows.map((r) => r.action)).toEqual(['approval.decided', 'message.posted']);
    expect(rows[1].prev_hash).toBe(rows[0].hash);
    expect(verifyAuditChain()).toEqual({ ok: true, rows: 2 });
  });

  it('refuses updates and deletes', () => {
    audit('role.granted', { target: 'slack:U1' });
    expect(() => getDb().prepare("UPDATE audit_log SET actor = 'x'").run()).toThrow(/append-only/);
    expect(() => getDb().prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });

  it('detects rows edited around the triggers', () => {
    audit('role.granted', { target: 'slack:U1' });
    audit('role.granted', { target: 'slack:U2' });
    getDb().exec('DROP TRIGGER audit_log_no_update');
    getDb().prepare("UPDATE audit_log SET target = 'slack:EVIL' WHERE id = 1").run();
    expect(verifyAuditChain()).toMatchObject({ ok: false, brokenAt: 1, reason: 'row contents changed' });
  });

  it('records role grants and account links from their own code paths', () => {
    upsertUser({ id: 'slack:U1', kind: 'slack', display_name: 'Ana', created_at: new Date().toISOString() });
    grantRole({
      user_id: 'slack:U1',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: new Date().toISOString(),
    });
    createUserLink('whatsapp:1555', 'slack:U1', 'slack:U1');
    removeUserLink('whatsapp:1555');
    expect(readAudit().map((r) => r.action)).toEqual(['role.granted', 'identity.linked', 'identity.unlinked']);
  });

  it('exports JSONL and CSV, filtered by action', () => {
    audit('host_exec.run', { target: 'exec-1', detail: { command: 'git status', note: 'has, comma "and quotes"' } });
    audit('message.posted', { target: 'm-1' });
    const jsonl = exportAudit('jsonl', { action: 'host_exec.*' }).split('\n');
    expect(jsonl).toHaveLength(1);
    expect(JSON.parse(jsonl[0])).toMatchObject({ action: 'host_exec.run', detail: { command: 'git status' } });
    const csv = exportAudit('csv').split('\n');
    expect(csv[0]).toBe('id,at,action,actor,target,agent_group_id,channel_type,detail_json,hash');
    expect(csv[1]).toContain('"{""command"":""git status""');
  });

  it('never throws into the caller', () => {
    closeDb();
    expect(() => audit('message.posted', {})).not.toThrow();
    runMigrations(initTestDb());
  });
});
