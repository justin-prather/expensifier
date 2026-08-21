import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

import { AuditRepository } from './audit';
import type { Actor } from './review';
export interface VendorRuleView {
	readonly id: string;
	readonly alias: string;
	readonly vendorName: string;
	readonly paymentAccountId: string | null;
	readonly categoryId: string | null;
	readonly clientId: string | null;
	readonly active: boolean;
	readonly paymentAccountName: string | null;
	readonly categoryName: string | null;
	readonly clientName: string | null;
}

export interface RuleSuggestion {
	readonly ruleId: string;
	readonly alias: string;
	readonly vendorName: string;
	readonly paymentAccountId: string | null;
	readonly categoryId: string | null;
	readonly clientId: string | null;
	readonly paymentAccountName: string | null;
	readonly categoryName: string | null;
	readonly clientName: string | null;
}

export interface VendorRuleInput {
	readonly alias: string;
	readonly vendorName: string;
	readonly paymentAccountId: string | null;
	readonly categoryId: string | null;
	readonly clientId: string | null;
}

export class VendorRuleError extends Schema.TaggedError<VendorRuleError>()('VendorRuleError', {
	message: Schema.String
}) {}

const aliasMaxLength = 120;
const vendorNameMaxLength = 200;

export function normalizeAlias(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/[.,;:!]+$/, '');
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface SuggestionRow {
	readonly id: string;
	readonly alias: string;
	readonly vendorName: string;
	readonly paymentAccountId: string | null;
	readonly categoryId: string | null;
	readonly clientId: string | null;
	readonly paymentAccountName: string | null;
	readonly categoryName: string | null;
	readonly clientName: string | null;
}

function toSuggestion(rule: SuggestionRow): RuleSuggestion {
	return {
		ruleId: rule.id,
		alias: rule.alias,
		vendorName: rule.vendorName,
		paymentAccountId: rule.paymentAccountId,
		categoryId: rule.categoryId,
		clientId: rule.clientId,
		paymentAccountName: rule.paymentAccountName,
		categoryName: rule.categoryName,
		clientName: rule.clientName
	};
}

interface RuleRow {
	readonly id: string;
	readonly alias: string;
	readonly vendorName: string;
	readonly paymentAccountId: string | null;
	readonly categoryId: string | null;
	readonly clientId: string | null;
	readonly active: number;
	readonly paymentAccountName: string | null;
	readonly categoryName: string | null;
	readonly clientName: string | null;
}

function rowToView(row: RuleRow): VendorRuleView {
	return {
		id: row.id,
		alias: row.alias,
		vendorName: row.vendorName,
		paymentAccountId: row.paymentAccountId,
		categoryId: row.categoryId,
		clientId: row.clientId,
		active: row.active === 1,
		paymentAccountName: row.paymentAccountName,
		categoryName: row.categoryName,
		clientName: row.clientName
	};
}

export class VendorRuleService extends Context.Service<
	VendorRuleService,
	{
		readonly list: Effect.Effect<ReadonlyArray<VendorRuleView>>;
		readonly create: (
			input: VendorRuleInput,
			actor: Actor
		) => Effect.Effect<VendorRuleView, VendorRuleError>;
		readonly update: (
			id: string,
			input: VendorRuleInput,
			actor: Actor
		) => Effect.Effect<void, VendorRuleError>;
		readonly setActive: (
			id: string,
			active: boolean,
			actor: Actor
		) => Effect.Effect<void, VendorRuleError>;
		readonly remove: (id: string, actor: Actor) => Effect.Effect<void, VendorRuleError>;
		readonly suggestForVendor: (vendorName: string | null) => Effect.Effect<RuleSuggestion | null>;
	}
>()('expensifier/VendorRuleService') {
	static readonly layerWithoutDependencies = Layer.effect(
		VendorRuleService,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const audit = yield* AuditRepository;

			const appendAudit = Effect.fn('VendorRuleService.appendAudit')(function* (input: {
				action: string;
				entityId: string;
				actor: Actor;
				data?: Record<string, unknown>;
			}) {
				yield* audit.append({
					actorUserId: input.actor.id,
					actorLabel: input.actor.label,
					action: input.action,
					entityType: 'vendor_rule',
					entityId: input.entityId,
					data: input.data
				});
			});

			const findById = Effect.fn('VendorRuleService.findById')(function* (id: string) {
				const rows = yield* sql<RuleRow>`
					SELECT r.id, r.alias, r.vendor_name AS vendorName,
						r.payment_account_id AS paymentAccountId, r.category_id AS categoryId,
						r.client_id AS clientId, r.active,
						p.name AS paymentAccountName, c.name AS categoryName, cl.name AS clientName
					FROM vendor_rules r
					LEFT JOIN payment_accounts p ON p.id = r.payment_account_id
					LEFT JOIN expense_categories c ON c.id = r.category_id
					LEFT JOIN clients cl ON cl.id = r.client_id
					WHERE r.id = ${id}
				`;
				return rows[0] ?? null;
			}, Effect.orDie);

			const validateInput = Effect.fn('VendorRuleService.validateInput')(function* (
				input: VendorRuleInput,
				excludeId?: string
			) {
				const alias = normalizeAlias(input.alias);
				if (alias.length === 0 || alias.length > aliasMaxLength) {
					return yield* Effect.fail(
						new VendorRuleError({
							message: 'Alias must be 1-120 characters'
						})
					);
				}
				const vendorName = input.vendorName.trim();
				if (vendorName.length === 0 || vendorName.length > vendorNameMaxLength) {
					return yield* Effect.fail(
						new VendorRuleError({
							message: 'Vendor name must be 1-200 characters'
						})
					);
				}
				const taken = yield* sql<{ readonly id: string }>`
					SELECT id FROM vendor_rules WHERE alias = ${alias} AND id <> ${excludeId ?? ''}
				`.pipe(Effect.orDie);
				if (taken.length > 0) {
					return yield* Effect.fail(
						new VendorRuleError({
							message: `A rule for alias "${alias}" already exists`
						})
					);
				}
				for (const [field, table] of [
					['paymentAccountId', 'payment_accounts'],
					['categoryId', 'expense_categories'],
					['clientId', 'clients']
				] as const) {
					const value = input[field];
					if (value === null) continue;
					const found =
						table === 'payment_accounts'
							? yield* sql<{ readonly id: string }>`
								SELECT id FROM payment_accounts WHERE id = ${value} AND active = 1
							`.pipe(Effect.orDie)
							: table === 'expense_categories'
								? yield* sql<{ readonly id: string }>`
									SELECT id FROM expense_categories WHERE id = ${value} AND active = 1
								`.pipe(Effect.orDie)
								: yield* sql<{ readonly id: string }>`
									SELECT id FROM clients WHERE id = ${value} AND active = 1
								`.pipe(Effect.orDie);
					if (found.length === 0) {
						return yield* Effect.fail(
							new VendorRuleError({
								message: 'Selected reference value is not available'
							})
						);
					}
				}
				return { alias, vendorName };
			});

			const list = Effect.gen(function* () {
				const rows = yield* sql<RuleRow>`
					SELECT r.id, r.alias, r.vendor_name AS vendorName,
						r.payment_account_id AS paymentAccountId, r.category_id AS categoryId,
						r.client_id AS clientId, r.active,
						p.name AS paymentAccountName, c.name AS categoryName, cl.name AS clientName
					FROM vendor_rules r
					LEFT JOIN payment_accounts p ON p.id = r.payment_account_id
					LEFT JOIN expense_categories c ON c.id = r.category_id
					LEFT JOIN clients cl ON cl.id = r.client_id
					ORDER BY r.alias COLLATE NOCASE
				`;
				return rows.map(rowToView);
			}).pipe(Effect.orDie);

			const create = Effect.fn('VendorRuleService.create')(function* (
				input: VendorRuleInput,
				actor: Actor
			) {
				const validated = yield* validateInput(input);
				const id = crypto.randomUUID();
				const now = new Date().toISOString();
				yield* sql`
					INSERT INTO vendor_rules (
						id, alias, vendor_name, payment_account_id, category_id, client_id, active,
						created_at, updated_at
					) VALUES (
						${id}, ${validated.alias}, ${validated.vendorName}, ${input.paymentAccountId},
						${input.categoryId}, ${input.clientId}, 1, ${now}, ${now}
					)
				`.pipe(Effect.orDie);
				yield* appendAudit({
					action: 'vendor_rule_created',
					entityId: id,
					actor,
					data: { alias: validated.alias, vendorName: validated.vendorName }
				});
				const created = yield* findById(id);
				return rowToView(created!);
			});

			const update = Effect.fn('VendorRuleService.update')(function* (
				id: string,
				input: VendorRuleInput,
				actor: Actor
			) {
				const existing = yield* findById(id);
				if (!existing) {
					return yield* Effect.fail(new VendorRuleError({ message: 'Rule not found' }));
				}
				const validated = yield* validateInput(input, id);
				const now = new Date().toISOString();
				yield* sql`
					UPDATE vendor_rules SET alias = ${validated.alias}, vendor_name = ${validated.vendorName},
						payment_account_id = ${input.paymentAccountId}, category_id = ${input.categoryId},
						client_id = ${input.clientId}, updated_at = ${now}
					WHERE id = ${id}
				`.pipe(Effect.orDie);
				yield* appendAudit({
					action: 'vendor_rule_updated',
					entityId: id,
					actor,
					data: { alias: validated.alias, vendorName: validated.vendorName }
				});
			});

			const setActive = Effect.fn('VendorRuleService.setActive')(function* (
				id: string,
				active: boolean,
				actor: Actor
			) {
				const existing = yield* findById(id);
				if (!existing) {
					return yield* Effect.fail(new VendorRuleError({ message: 'Rule not found' }));
				}
				const now = new Date().toISOString();
				yield* sql`
					UPDATE vendor_rules SET active = ${active ? 1 : 0}, updated_at = ${now} WHERE id = ${id}
				`.pipe(Effect.orDie);
				yield* appendAudit({
					action: active ? 'vendor_rule_activated' : 'vendor_rule_deactivated',
					entityId: id,
					actor,
					data: { alias: existing.alias }
				});
			});

			const remove = Effect.fn('VendorRuleService.remove')(function* (id: string, actor: Actor) {
				const existing = yield* findById(id);
				if (!existing) {
					return yield* Effect.fail(new VendorRuleError({ message: 'Rule not found' }));
				}
				yield* sql`DELETE FROM vendor_rules WHERE id = ${id}`.pipe(Effect.orDie);
				yield* appendAudit({
					action: 'vendor_rule_deleted',
					entityId: id,
					actor,
					data: { alias: existing.alias }
				});
			});

			const suggestForVendor = Effect.fn('VendorRuleService.suggestForVendor')(function* (
				vendorName: string | null
			) {
				if (!vendorName || vendorName.trim() === '') return null;
				const normalized = normalizeAlias(vendorName);
				if (normalized === '') return null;
				const rules = yield* sql<{
					readonly id: string;
					readonly alias: string;
					readonly vendorName: string;
					readonly paymentAccountId: string | null;
					readonly categoryId: string | null;
					readonly clientId: string | null;
					readonly paymentAccountName: string | null;
					readonly categoryName: string | null;
					readonly clientName: string | null;
				}>`
					SELECT r.id, r.alias, r.vendor_name AS vendorName,
						r.payment_account_id AS paymentAccountId, r.category_id AS categoryId,
						r.client_id AS clientId,
						p.name AS paymentAccountName, c.name AS categoryName, cl.name AS clientName
					FROM vendor_rules r
					LEFT JOIN payment_accounts p ON p.id = r.payment_account_id
					LEFT JOIN expense_categories c ON c.id = r.category_id
					LEFT JOIN clients cl ON cl.id = r.client_id
					WHERE r.active = 1
				`.pipe(Effect.orDie);
				const exact = rules.find((rule) => rule.alias === normalized);
				if (exact) return toSuggestion(exact);
				const partial = rules
					.filter(
						(rule) =>
							rule.alias.length >= 3 &&
							(normalized.includes(rule.alias) ||
								new RegExp(`\\b${escapeRegExp(rule.alias)}\\b`).test(normalized))
					)
					.toSorted((a, b) => b.alias.length - a.alias.length)[0];
				if (!partial) return null;
				return toSuggestion(partial);
			});

			return VendorRuleService.of({
				list,
				create,
				update,
				setActive,
				remove,
				suggestForVendor
			});
		})
	);
}
