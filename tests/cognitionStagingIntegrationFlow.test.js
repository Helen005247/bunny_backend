'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { acceptance } = require('./cognitionStagingIntegration')

// An in-memory PostgREST-shaped test double; only verifies the acceptance
// script's own control flow. It does NOT replace the required real staging run.
function dbDouble() {
    const rows = []
    class Query {
        constructor() { this.filters = []; this.sort = []; this.mode = 'read'; this.cap = Infinity }
        select() { return this }
        eq(k, v) { this.filters.push((r) => r[k] === v); return this }
        lte(k, v) { this.filters.push((r) => r[k] != null && r[k] <= v); return this }
        order(k, { ascending = true } = {}) { this.sort.push({ k, ascending }); return this }
        limit(n) { this.cap = n; return this }
        insert(payload) { this.mode = 'insert'; this.payload = structuredClone(payload); return this }
        update(payload) { this.mode = 'update'; this.payload = structuredClone(payload); return this }
        delete() { this.mode = 'delete'; return this }
        matching() {
            return rows.filter((r) => this.filters.every((f) => f(r))).sort((a,b) => {
                for (const { k, ascending } of this.sort) {
                    if (a[k] === b[k]) continue
                    return (a[k] < b[k] ? -1 : 1) * (ascending ? 1 : -1)
                }
                return 0
            }).slice(0, this.cap)
        }
        async result(single) {
            if (this.mode === 'insert') {
                const match = rows.find((r) => this.payload.dedupe_key != null &&
                    r.dedupe_key === this.payload.dedupe_key &&
                    r.user_id === this.payload.user_id && r.agent_id === this.payload.agent_id)
                if (match) return { data: null, error: { code: '23505' } }
                const r = { id: crypto.randomUUID(), status: 'open', version: 0,
                    result: null, closed_at: null, ...this.payload }
                rows.push(r)
                return { data: structuredClone(single ? r : [r]), error: null }
            }
            const hit = this.matching()
            if (this.mode === 'update') hit.forEach((row) => Object.assign(row, this.payload))
            if (this.mode === 'delete') {
                for (const item of hit) rows.splice(rows.indexOf(item), 1)
            }
            return { data: structuredClone(single ? hit[0] || null : hit), error: null }
        }
        single() { return this.result(true) }
        maybeSingle() { return this.result(true) }
        then(ok,fail) { return this.result(false).then(ok,fail) }
    }
    return { rows, from(name) {
        assert.equal(name, 'agent_thought_threads')
        return new Query()
    } }
}

test('the staging acceptance script tests creation, resumption, closure, and cleans up', async () => {
    const db = dbDouble()
    const output = []
    assert.equal(await acceptance({ supabase: db, onStatus: (s) => output.push(s) }), true)
    assert.ok(output.some((s) => s.includes('second simulated round')))
    assert.ok(output.some((s) => s.includes('stale version')))
    assert.ok(output.some((s) => s.includes('deleted')))
    assert.equal(db.rows.length, 0)
})
