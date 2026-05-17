import { describe, expect, it, vi } from 'vitest';

vi.mock('./db/connection.js', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => null,
    }),
  }),
  hasTable: () => true,
}));

const { gateCommand } = await import('./command-gate.js');

describe('gateCommand', () => {
  it('filters host-only slash commands by exact first token', () => {
    expect(gateCommand(JSON.stringify({ text: '/start' }), 'telegram:1', 'ag-1')).toEqual({ action: 'filter' });
    expect(gateCommand(JSON.stringify({ text: '/help please' }), 'telegram:1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('does not treat command prefixes as known commands', () => {
    expect(gateCommand(JSON.stringify({ text: '/clearfoo' }), null, 'ag-1')).toEqual({ action: 'pass' });
    expect(gateCommand(JSON.stringify({ text: '/startnow' }), null, 'ag-1')).toEqual({ action: 'pass' });
  });

  it('denies admin commands to non-admin users by exact first token', () => {
    expect(gateCommand(JSON.stringify({ text: '/clear' }), 'telegram:2', 'ag-1')).toEqual({
      action: 'deny',
      command: '/clear',
    });
    expect(gateCommand(JSON.stringify({ text: '/clear please' }), 'telegram:2', 'ag-1')).toEqual({
      action: 'deny',
      command: '/clear',
    });
  });

  it('passes ordinary text and unknown slash commands through', () => {
    expect(gateCommand(JSON.stringify({ text: 'hello' }), null, 'ag-1')).toEqual({ action: 'pass' });
    expect(gateCommand(JSON.stringify({ text: '/unknown arg' }), null, 'ag-1')).toEqual({ action: 'pass' });
  });
});
