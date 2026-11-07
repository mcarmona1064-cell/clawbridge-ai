import { describe, expect, it } from 'bun:test';

import { buildScript, parseJsonArrays, refuseSql, toTable } from './data.js';

describe('query_data', () => {
  it('allows single reads and refuses anything that writes or reaches out', () => {
    expect(refuseSql("SELECT region, sum(amount) FROM '/workspace/sales.csv' GROUP BY 1")).toBeNull();
    expect(refuseSql('WITH t AS (SELECT 1) SELECT * FROM t;')).toBeNull();
    expect(refuseSql("SELECT 'drop table' AS note")).toBeNull(); // keyword inside a string is fine
    expect(refuseSql("COPY (SELECT 1) TO '/workspace/x.csv'")).toMatch(/Only reads/);
    expect(refuseSql("SELECT 1; ATTACH 'x.db'")).toMatch(/One statement/);
    expect(refuseSql("SELECT * FROM read_csv('https://evil.test/x.csv')")).toMatch(/Only files in \/workspace/);
    expect(refuseSql('SELECT * FROM t WHERE x IN (SELECT 1) AND 1=1 OR install_x')).toBeNull();
    expect(refuseSql('FROM (SELECT 1) SELECT * , (INSTALL httpfs)')).toMatch(/INSTALL/);
  });

  it('locks DuckDB down before running, and counts rows', () => {
    const script = buildScript('SELECT * FROM t', 50);
    expect(script.indexOf('enable_external_access = false')).toBeLessThan(script.indexOf('SELECT count(*)'));
    expect(script).toContain('lock_configuration = true');
    expect(script).toContain('SELECT * FROM (SELECT * FROM t) LIMIT 50');
    expect(buildScript('DESCRIBE t')).toMatch(/\nDESCRIBE t$/);
  });

  it('parses DuckDB -json output and renders a table', () => {
    const arrays = parseJsonArrays('[{"__rows":2}]\n[{"region":"EU","total":10},{"region":"US|x","total":5}]\n');
    expect(arrays).toHaveLength(2);
    expect(arrays[0][0].__rows).toBe(2);
    expect(toTable(arrays[1])).toBe('| region | total |\n| --- | --- |\n| EU | 10 |\n| US\\|x | 5 |');
  });
});
