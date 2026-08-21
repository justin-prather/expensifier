import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Result } from 'effect';

import { AuditRepository } from './audit';
import { makeDatabaseLayer } from './database';
import { ReferenceService, isReferenceKind } from './reference';
import { VendorRuleService } from './rules';
import { defaultDestinationTemplate, defaultFilenameTemplate } from './templates';

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

describe('reference data management', () => {
	it.live('creates, renames, and lists reference records with usage flags', () => {
		const layer = makeLayer();
		return Effect.gen(function* () {
			const refs = yield* ReferenceService;

			const account = yield* refs.create('payment_account', '9999-Test-VISA', actor);
			expect(account.name).toBe('9999-Test-VISA');
			expect(account.active).toBe(true);
			expect(account.inUse).toBe(false);

			const duplicate = yield* Effect.result(
				refs.create('payment_account', '9999-test-visa', actor)
			);
			expect(Result.isFailure(duplicate)).toBe(true);
			if (Result.isFailure(duplicate)) {
				expect(duplicate.failure.message).toContain('already exists');
			}

			yield* refs.rename('payment_account', account.id, '8888-Renamed-VISA', actor);
			const listed = yield* refs.list('payment_account');
			const renamed = listed.find((entry) => entry.id === account.id);
			expect(renamed?.name).toBe('8888-Renamed-VISA');

			const invalid = yield* Effect.result(refs.create('client', '   ', actor));
			expect(Result.isFailure(invalid)).toBe(true);

			const events = yield* AuditRepository.use((repository) => repository.listRecent(10));
			const actions = events.map((event) => event.action);
			expect(actions).toContain('reference_created');
			expect(actions).toContain('reference_updated');
		}).pipe(Effect.provide(layer));
	});

	it.live('deactivates referenced records and blocks deleting them', () => {
		const layer = makeLayer();
		return Effect.gen(function* () {
			const refs = yield* ReferenceService;
			const rules = yield* VendorRuleService;

			const category = yield* refs.create('category', 'Fixture Hardware', actor);
			const account = yield* refs.create('payment_account', '1111-In-Use', actor);
			yield* rules.create(
				{
					alias: 'fixture vendor',
					vendorName: 'Fixture Vendor',
					paymentAccountId: account.id,
					categoryId: null,
					clientId: null
				},
				actor
			);

			const blocked = yield* Effect.result(refs.remove('payment_account', account.id, actor));
			expect(Result.isFailure(blocked)).toBe(true);
			if (Result.isFailure(blocked)) {
				expect(blocked.failure.message).toContain('deactivate it instead');
			}

			yield* refs.setActive('category', category.id, false, actor);
			const listed = yield* refs.list('category');
			const deactivated = listed.find((entry) => entry.id === category.id);
			expect(deactivated?.active).toBe(false);
			expect(deactivated?.inUse).toBe(false);

			const unusedClient = yield* refs.create('client', 'Unused Client', actor);
			const removed = yield* Effect.result(refs.remove('client', unusedClient.id, actor));
			expect(Result.isSuccess(removed)).toBe(true);
			const afterRemove = yield* refs.list('client');
			expect(afterRemove.find((entry) => entry.id === unusedClient.id)).toBeUndefined();

			const events = yield* AuditRepository.use((repository) => repository.listRecent(10));
			const actions = events.map((event) => event.action);
			expect(actions).toContain('reference_deactivated');
			expect(actions).toContain('reference_deleted');
		}).pipe(Effect.provide(layer));
	});

	it.live('persists filename and destination templates with validation', () => {
		const layer = makeLayer();
		return Effect.gen(function* () {
			const refs = yield* ReferenceService;

			const initial = yield* refs.templates;
			expect(initial.filename).toBe(defaultFilenameTemplate);
			expect(initial.destination).toBe(defaultDestinationTemplate);

			const saved = yield* refs.saveTemplates(
				{ filename: '{date} {vendor}.{extension}', destination: 'processed/{billableSubdir}' },
				actor
			);
			expect(saved.filename).toBe('{date} {vendor}.{extension}');
			const reloaded = yield* refs.templates;
			expect(reloaded.filename).toBe('{date} {vendor}.{extension}');

			const invalidToken = yield* Effect.result(
				refs.saveTemplates({ filename: '{nonsense}.{extension}', destination: 'processed' }, actor)
			);
			expect(Result.isFailure(invalidToken)).toBe(true);
			if (Result.isFailure(invalidToken)) {
				expect(invalidToken.failure.message).toContain('{nonsense}');
			}

			const empty = yield* Effect.result(
				refs.saveTemplates({ filename: '   ', destination: 'processed' }, actor)
			);
			expect(Result.isFailure(empty)).toBe(true);

			const events = yield* AuditRepository.use((repository) => repository.listRecent(5));
			expect(events.map((event) => event.action)).toContain('template_updated');
		}).pipe(Effect.provide(layer));
	});

	it.live('validates reference kinds', () => {
		const layer = makeLayer();
		return Effect.gen(function* () {
			yield* Effect.void;
			expect(isReferenceKind('payment_account')).toBe(true);
			expect(isReferenceKind('category')).toBe(true);
			expect(isReferenceKind('client')).toBe(true);
			expect(isReferenceKind('vendor_rule')).toBe(false);
			expect(isReferenceKind(42)).toBe(false);
		}).pipe(Effect.provide(layer));
	});
});
