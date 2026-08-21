import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Result } from 'effect';

import { AuditRepository } from './audit';
import { makeDatabaseLayer } from './database';
import { ReferenceService } from './reference';
import { VendorRuleService, normalizeAlias } from './rules';

const actor = { id: 'user-1', label: 'Admin One' };

function makeLayer() {
	const persistence = Layer.mergeAll(AuditRepository.layerWithoutDependencies).pipe(
		Layer.provideMerge(makeDatabaseLayer(':memory:'))
	);
	return Layer.mergeAll(
		ReferenceService.layerWithoutDependencies,
		VendorRuleService.layerWithoutDependencies
	).pipe(Layer.provideMerge(persistence));
}

describe('vendor rules and deterministic suggestions', () => {
	it.live('normalizes aliases for storage and matching', () => {
		const layer = makeLayer();
		return Effect.gen(function* () {
			yield* Effect.void;
			expect(normalizeAlias('  Home   Depot! ')).toBe('home depot');
			expect(normalizeAlias('Staples,')).toBe('staples');
			expect(normalizeAlias('   ')).toBe('');
		}).pipe(Effect.provide(layer));
	});

	it.live('matches exact aliases case-insensitively and falls back to substring matches', () => {
		const layer = makeLayer();
		return Effect.gen(function* () {
			const refs = yield* ReferenceService;
			const rules = yield* VendorRuleService;

			const account = yield* refs.create('payment_account', '7740-Test-VISA', actor);
			const category = yield* refs.create('category', 'Fixture Hardware', actor);
			const client = yield* refs.create('client', 'Acme Corp', actor);

			yield* rules.create(
				{
					alias: 'Home Depot',
					vendorName: 'Home Depot Canada',
					paymentAccountId: account.id,
					categoryId: category.id,
					clientId: null
				},
				actor
			);
			yield* rules.create(
				{
					alias: 'staples',
					vendorName: 'Staples Business Advantage',
					paymentAccountId: null,
					categoryId: null,
					clientId: client.id
				},
				actor
			);

			const exact = yield* rules.suggestForVendor('HOME DEPOT');
			expect(exact?.alias).toBe('home depot');
			expect(exact?.vendorName).toBe('Home Depot Canada');
			expect(exact?.paymentAccountId).toBe(account.id);
			expect(exact?.categoryId).toBe(category.id);

			const partial = yield* rules.suggestForVendor('Home Depot Inc. Store 42');
			expect(partial?.vendorName).toBe('Home Depot Canada');

			const punctuation = yield* rules.suggestForVendor('Staples, Inc.');
			expect(punctuation?.vendorName).toBe('Staples Business Advantage');
			expect(punctuation?.clientId).toBe(client.id);

			const none = yield* rules.suggestForVendor('Totally Unrelated Vendor');
			expect(none).toBeNull();
			expect(yield* rules.suggestForVendor(null)).toBeNull();
			expect(yield* rules.suggestForVendor('   ')).toBeNull();
		}).pipe(Effect.provide(layer));
	});

	it.live('ignores inactive rules and prefers the most specific alias', () => {
		const layer = makeLayer();
		return Effect.gen(function* () {
			const rules = yield* VendorRuleService;

			const specific = yield* rules.create(
				{
					alias: 'apple store canada',
					vendorName: 'Apple Canada',
					paymentAccountId: null,
					categoryId: null,
					clientId: null
				},
				actor
			);
			const generic = yield* rules.create(
				{
					alias: 'apple',
					vendorName: 'Apple Generic',
					paymentAccountId: null,
					categoryId: null,
					clientId: null
				},
				actor
			);

			const preferred = yield* rules.suggestForVendor('Apple Store Canada');
			expect(preferred?.vendorName).toBe('Apple Canada');

			yield* rules.setActive(specific.id, false, actor);
			const afterDeactivate = yield* rules.suggestForVendor('Apple Store Canada');
			expect(afterDeactivate?.vendorName).toBe('Apple Generic');

			yield* rules.setActive(generic.id, false, actor);
			expect(yield* rules.suggestForVendor('Apple Store Canada')).toBeNull();

			const events = yield* AuditRepository.use((repository) => repository.listRecent(10));
			expect(events.map((event) => event.action)).toContain('vendor_rule_deactivated');
		}).pipe(Effect.provide(layer));
	});

	it.live('validates rule input and rejects unavailable reference values', () => {
		const layer = makeLayer();
		return Effect.gen(function* () {
			const rules = yield* VendorRuleService;

			const duplicate = yield* Effect.result(
				rules.create(
					{
						alias: 'same alias',
						vendorName: 'First',
						paymentAccountId: null,
						categoryId: null,
						clientId: null
					},
					actor
				)
			);
			expect(Result.isSuccess(duplicate)).toBe(true);

			const second = yield* Effect.result(
				rules.create(
					{
						alias: 'Same Alias',
						vendorName: 'Second',
						paymentAccountId: null,
						categoryId: null,
						clientId: null
					},
					actor
				)
			);
			expect(Result.isFailure(second)).toBe(true);
			if (Result.isFailure(second)) {
				expect(second.failure.message).toContain('already exists');
			}

			const missingReference = yield* Effect.result(
				rules.create(
					{
						alias: 'ghost',
						vendorName: 'Ghost Vendor',
						paymentAccountId: crypto.randomUUID(),
						categoryId: null,
						clientId: null
					},
					actor
				)
			);
			expect(Result.isFailure(missingReference)).toBe(true);
			if (Result.isFailure(missingReference)) {
				expect(missingReference.failure.message).toContain('not available');
			}

			const blankAlias = yield* Effect.result(
				rules.create(
					{
						alias: '   ',
						vendorName: 'Blank Alias',
						paymentAccountId: null,
						categoryId: null,
						clientId: null
					},
					actor
				)
			);
			expect(Result.isFailure(blankAlias)).toBe(true);

			const existing = yield* rules.list;
			const target = existing[0]!;
			yield* rules.update(
				target.id,
				{
					alias: 'updated alias',
					vendorName: 'Updated Vendor',
					paymentAccountId: null,
					categoryId: null,
					clientId: null
				},
				actor
			);
			const afterUpdate = yield* rules.list;
			expect(afterUpdate[0]?.alias).toBe('updated alias');

			yield* rules.remove(target.id, actor);
			const afterRemove = yield* rules.list;
			expect(afterRemove.find((entry) => entry.id === target.id)).toBeUndefined();

			const events = yield* AuditRepository.use((repository) => repository.listRecent(10));
			const actions = events.map((event) => event.action);
			expect(actions).toContain('vendor_rule_updated');
			expect(actions).toContain('vendor_rule_deleted');
		}).pipe(Effect.provide(layer));
	});
});
