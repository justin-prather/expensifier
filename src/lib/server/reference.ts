import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

import { AuditRepository } from './audit';
import type { Actor } from './review';
import { validateTemplate } from './templates';

export const referenceKinds = ['payment_account', 'category', 'client'] as const;
export type ReferenceKind = (typeof referenceKinds)[number];

const kindTables: Record<ReferenceKind, string> = {
	payment_account: 'payment_accounts',
	category: 'expense_categories',
	client: 'clients'
};

function usageFilter(kind: ReferenceKind): string {
	switch (kind) {
		case 'payment_account':
			return 'EXISTS (SELECT 1 FROM expenses WHERE expenses.payment_account_id = t.id)\n\t\t\t\t\t\tOR EXISTS (SELECT 1 FROM vendor_rules WHERE vendor_rules.payment_account_id = t.id)';
		case 'category':
			return 'EXISTS (SELECT 1 FROM expense_line_items WHERE expense_line_items.category_id = t.id)\n\t\t\t\t\t\tOR EXISTS (SELECT 1 FROM vendor_rules WHERE vendor_rules.category_id = t.id)';
		case 'client':
			return 'EXISTS (SELECT 1 FROM expenses WHERE expenses.client_id = t.id)\n\t\t\t\t\t\tOR EXISTS (SELECT 1 FROM expense_clients WHERE expense_clients.client_id = t.id)\n\t\t\t\t\t\tOR EXISTS (SELECT 1 FROM expense_line_items WHERE expense_line_items.client_id = t.id)\n\t\t\t\t\t\tOR EXISTS (SELECT 1 FROM vendor_rules WHERE vendor_rules.client_id = t.id)';
	}
}

const kindLabels: Record<ReferenceKind, string> = {
	payment_account: 'Payment account',
	category: 'Category',
	client: 'Client'
};

export function isReferenceKind(value: unknown): value is ReferenceKind {
	return typeof value === 'string' && (referenceKinds as readonly string[]).includes(value);
}

export class ManagedReference extends Schema.Class<ManagedReference>('ManagedReference')({
	id: Schema.String,
	name: Schema.String,
	active: Schema.Boolean,
	inUse: Schema.Boolean
}) {}

export interface StoredTemplates {
	readonly filename: string;
	readonly destination: string;
}

export class ReferenceError extends Schema.TaggedError<ReferenceError>()('ReferenceError', {
	message: Schema.String
}) {}

export class ReferenceTemplateError extends Schema.TaggedError<ReferenceTemplateError>()(
	'ReferenceTemplateError',
	{ message: Schema.String }
) {}

export interface TemplateInput {
	readonly filename: string;
	readonly destination: string;
}

interface TableRow {
	readonly id: string;
	readonly name: string;
	readonly active: number;
}

function referenceNameIsValid(name: string): boolean {
	const trimmed = name.trim();
	return trimmed.length > 0 && trimmed.length <= 120;
}

export class ReferenceService extends Context.Service<
	ReferenceService,
	{
		readonly list: (kind: ReferenceKind) => Effect.Effect<ReadonlyArray<ManagedReference>>;
		readonly create: (
			kind: ReferenceKind,
			name: string,
			actor: Actor
		) => Effect.Effect<ManagedReference, ReferenceError>;
		readonly rename: (
			kind: ReferenceKind,
			id: string,
			name: string,
			actor: Actor
		) => Effect.Effect<void, ReferenceError>;
		readonly setActive: (
			kind: ReferenceKind,
			id: string,
			active: boolean,
			actor: Actor
		) => Effect.Effect<void, ReferenceError>;
		readonly remove: (
			kind: ReferenceKind,
			id: string,
			actor: Actor
		) => Effect.Effect<void, ReferenceError>;
		readonly templates: Effect.Effect<StoredTemplates>;
		readonly saveTemplates: (
			input: TemplateInput,
			actor: Actor
		) => Effect.Effect<StoredTemplates, ReferenceTemplateError>;
	}
>()('expensifier/ReferenceService') {
	static readonly layerWithoutDependencies = Layer.effect(
		ReferenceService,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const audit = yield* AuditRepository;

			const tableName = (kind: ReferenceKind) => {
				const table = kindTables[kind];
				return sql.unsafe(table);
			};

			const findById = Effect.fn('ReferenceService.findById')(function* (
				kind: ReferenceKind,
				id: string
			) {
				const rows = yield* sql<TableRow>`
					SELECT id, name, active FROM ${tableName(kind)} WHERE id = ${id}
				`;
				return rows[0] ?? null;
			}, Effect.orDie);

			const nameTaken = Effect.fn('ReferenceService.nameTaken')(function* (
				kind: ReferenceKind,
				name: string,
				excludeId?: string
			) {
				const rows = excludeId
					? yield* sql<{ readonly id: string }>`
						SELECT id FROM ${tableName(kind)} WHERE lower(name) = lower(${name}) AND id <> ${excludeId}
					`
					: yield* sql<{ readonly id: string }>`
						SELECT id FROM ${tableName(kind)} WHERE lower(name) = lower(${name})
					`;
				return rows.length > 0;
			}, Effect.orDie);

			const appendAudit = Effect.fn('ReferenceService.appendAudit')(function* (input: {
				kind: ReferenceKind;
				action: string;
				entityId: string;
				actor: Actor;
				data?: Record<string, unknown>;
			}) {
				yield* audit.append({
					actorUserId: input.actor.id,
					actorLabel: input.actor.label,
					action: input.action,
					entityType: input.kind,
					entityId: input.entityId,
					data: input.data
				});
			});

			const list = Effect.fn('ReferenceService.list')(function* (kind: ReferenceKind) {
				const rows = yield* sql<TableRow & { readonly inUse: number }>`
					SELECT t.id, t.name, t.active,
						CASE WHEN ${sql.unsafe(usageFilter(kind))} THEN 1 ELSE 0 END AS inUse
					FROM ${tableName(kind)} t
					ORDER BY t.name COLLATE NOCASE
				`;
				return rows.map(
					(row) =>
						new ManagedReference({
							id: row.id,
							name: row.name,
							active: row.active === 1,
							inUse: row.inUse === 1
						})
				);
			}, Effect.orDie);

			const create = Effect.fn('ReferenceService.create')(function* (
				kind: ReferenceKind,
				name: string,
				actor: Actor
			) {
				const trimmed = name.trim();
				if (!referenceNameIsValid(trimmed)) {
					return yield* Effect.fail(
						new ReferenceError({
							message: `${kindLabels[kind]} name must be 1-120 characters`
						})
					);
				}
				if (yield* nameTaken(kind, trimmed)) {
					return yield* Effect.fail(
						new ReferenceError({
							message: `${kindLabels[kind]} "${trimmed}" already exists`
						})
					);
				}
				const id = crypto.randomUUID();
				const now = new Date().toISOString();
				yield* sql`
					INSERT INTO ${tableName(kind)} (id, name, active, created_at)
					VALUES (${id}, ${trimmed}, 1, ${now})
				`.pipe(Effect.orDie);
				yield* appendAudit({
					kind,
					action: 'reference_created',
					entityId: id,
					actor,
					data: { name: trimmed }
				});
				return new ManagedReference({
					id,
					name: trimmed,
					active: true,
					inUse: false
				});
			});

			const rename = Effect.fn('ReferenceService.rename')(function* (
				kind: ReferenceKind,
				id: string,
				name: string,
				actor: Actor
			) {
				const existing = yield* findById(kind, id);
				if (!existing) {
					return yield* Effect.fail(
						new ReferenceError({ message: `${kindLabels[kind]} not found` })
					);
				}
				const trimmed = name.trim();
				if (!referenceNameIsValid(trimmed)) {
					return yield* Effect.fail(
						new ReferenceError({
							message: `${kindLabels[kind]} name must be 1-120 characters`
						})
					);
				}
				if (yield* nameTaken(kind, trimmed, id)) {
					return yield* Effect.fail(
						new ReferenceError({
							message: `${kindLabels[kind]} "${trimmed}" already exists`
						})
					);
				}
				yield* sql`
					UPDATE ${tableName(kind)} SET name = ${trimmed} WHERE id = ${id}
				`.pipe(Effect.orDie);
				yield* appendAudit({
					kind,
					action: 'reference_updated',
					entityId: id,
					actor,
					data: { name: trimmed, previousName: existing.name }
				});
			});

			const setActive = Effect.fn('ReferenceService.setActive')(function* (
				kind: ReferenceKind,
				id: string,
				active: boolean,
				actor: Actor
			) {
				const existing = yield* findById(kind, id);
				if (!existing) {
					return yield* Effect.fail(
						new ReferenceError({ message: `${kindLabels[kind]} not found` })
					);
				}
				yield* sql`
					UPDATE ${tableName(kind)} SET active = ${active ? 1 : 0}
					WHERE id = ${id}
				`.pipe(Effect.orDie);
				yield* appendAudit({
					kind,
					action: active ? 'reference_activated' : 'reference_deactivated',
					entityId: id,
					actor,
					data: { name: existing.name }
				});
			});

			const remove = Effect.fn('ReferenceService.remove')(function* (
				kind: ReferenceKind,
				id: string,
				actor: Actor
			) {
				const existing = yield* findById(kind, id);
				if (!existing) {
					return yield* Effect.fail(
						new ReferenceError({ message: `${kindLabels[kind]} not found` })
					);
				}
				const rows = yield* sql<{ readonly inUse: number }>`
					SELECT CASE WHEN ${sql.unsafe(usageFilter(kind))} THEN 1 ELSE 0 END AS inUse
					FROM ${tableName(kind)} t WHERE t.id = ${id}
				`.pipe(Effect.orDie);
				if ((rows[0]?.inUse ?? 0) === 1) {
					return yield* Effect.fail(
						new ReferenceError({
							message: `${kindLabels[kind]} "${existing.name}" is referenced by historical data; deactivate it instead`
						})
					);
				}
				yield* sql`DELETE FROM ${tableName(kind)} WHERE id = ${id}`.pipe(Effect.orDie);
				yield* appendAudit({
					kind,
					action: 'reference_deleted',
					entityId: id,
					actor,
					data: { name: existing.name }
				});
			});

			const templates = Effect.gen(function* () {
				const rows = yield* sql<{
					readonly key: string;
					readonly value: string;
				}>`
					SELECT key, value FROM app_settings
					WHERE key IN ('filename_template', 'destination_template')
				`;
				const stored = new Map(rows.map((row) => [row.key, row.value]));
				return {
					filename:
						stored.get('filename_template') ??
						'{date} {vendor} {amount} {paymentAccount} {notes} {billable}.{extension}',
					destination: stored.get('destination_template') ?? 'processed/{billableSubdir}'
				};
			}).pipe(Effect.orDie);

			const saveTemplates = Effect.fn('ReferenceService.saveTemplates')(function* (
				input: TemplateInput,
				actor: Actor
			) {
				try {
					validateTemplate(input.filename);
					validateTemplate(input.destination);
				} catch (cause) {
					return yield* Effect.fail(
						new ReferenceTemplateError({
							message: cause instanceof Error ? cause.message : 'Invalid template'
						})
					);
				}
				const now = new Date().toISOString();
				yield* sql`
					INSERT INTO app_settings (key, value, updated_at) VALUES ('filename_template', ${input.filename}, ${now})
					ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
				`.pipe(Effect.orDie);
				yield* sql`
					INSERT INTO app_settings (key, value, updated_at) VALUES ('destination_template', ${input.destination}, ${now})
					ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
				`.pipe(Effect.orDie);
				yield* audit.append({
					actorUserId: actor.id,
					actorLabel: actor.label,
					action: 'template_updated',
					entityType: 'template',
					entityId: 'app_settings',
					data: { filename: input.filename, destination: input.destination }
				});
				return { filename: input.filename, destination: input.destination };
			});

			return ReferenceService.of({
				list,
				create,
				rename,
				setActive,
				remove,
				templates,
				saveTemplates
			});
		})
	);
}
