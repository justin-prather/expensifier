import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export class AuditEvent extends Schema.Class<AuditEvent>('AuditEvent')({
	id: Schema.String,
	actorUserId: Schema.NullOr(Schema.String),
	actorLabel: Schema.String,
	action: Schema.String,
	entityType: Schema.String,
	entityId: Schema.String,
	dataJson: Schema.NullOr(Schema.String),
	createdAt: Schema.String
}) {}

export interface AppendAuditInput {
	readonly actorUserId: string | null;
	readonly actorLabel: string;
	readonly action: string;
	readonly entityType: string;
	readonly entityId: string;
	readonly data?: Readonly<Record<string, unknown>>;
}

const auditColumns = `
	id, actor_user_id AS actorUserId, actor_label AS actorLabel, action,
	entity_type AS entityType, entity_id AS entityId, data_json AS dataJson,
	created_at AS createdAt
`;

export class AuditRepository extends Context.Service<
	AuditRepository,
	{
		readonly append: (input: AppendAuditInput) => Effect.Effect<void>;
		readonly listForEntity: (
			entityType: string,
			entityId: string
		) => Effect.Effect<ReadonlyArray<AuditEvent>>;
		readonly listRecent: (limit: number) => Effect.Effect<ReadonlyArray<AuditEvent>>;
	}
>()('expensifier/AuditRepository') {
	static readonly layerWithoutDependencies = Layer.effect(
		AuditRepository,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			const append = Effect.fn('AuditRepository.append')(function* (input: AppendAuditInput) {
				const now = new Date().toISOString();
				yield* sql`
					INSERT INTO audit_events (
						id, actor_user_id, actor_label, action, entity_type, entity_id, data_json, created_at
					) VALUES (
						${crypto.randomUUID()}, ${input.actorUserId}, ${input.actorLabel},
						${input.action}, ${input.entityType}, ${input.entityId},
						${input.data ? JSON.stringify(input.data) : null}, ${now}
					)
				`;
			}, Effect.orDie);

			const listForEntity = Effect.fn('AuditRepository.listForEntity')(function* (
				entityType: string,
				entityId: string
			) {
				const rows = yield* sql<AuditEvent>`
					SELECT ${sql.unsafe(auditColumns)} FROM audit_events
					WHERE entity_type = ${entityType} AND entity_id = ${entityId}
					ORDER BY created_at DESC, id DESC
				`;
				return rows.map((row) => new AuditEvent(row));
			}, Effect.orDie);

			const listRecent = Effect.fn('AuditRepository.listRecent')(function* (limit: number) {
				const rows = yield* sql<AuditEvent>`
					SELECT ${sql.unsafe(auditColumns)} FROM audit_events
					ORDER BY created_at DESC, id DESC LIMIT ${limit}
				`;
				return rows.map((row) => new AuditEvent(row));
			}, Effect.orDie);

			return AuditRepository.of({
				append,
				listForEntity,
				listRecent
			});
		})
	);
}
