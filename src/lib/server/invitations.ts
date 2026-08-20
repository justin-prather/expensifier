import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

import type { Role } from './authorization';
import { DatabaseLive } from './database';

interface InvitationRow {
	readonly id: string;
	readonly email: string;
	readonly role: Role;
	readonly tokenHash: string;
	readonly invitedByUserId: string;
	readonly expiresAt: string;
	readonly acceptedAt: string | null;
	readonly acceptedByUserId: string | null;
	readonly revokedAt: string | null;
	readonly createdAt: string;
}

export class Invitation extends Schema.Class<Invitation>('Invitation')({
	id: Schema.String,
	email: Schema.String,
	role: Schema.Literals(['admin', 'accountant']),
	invitedByUserId: Schema.String,
	expiresAt: Schema.String,
	acceptedAt: Schema.NullOr(Schema.String),
	acceptedByUserId: Schema.NullOr(Schema.String),
	revokedAt: Schema.NullOr(Schema.String),
	createdAt: Schema.String
}) {}

export class InvitationError extends Schema.TaggedError<InvitationError>()('InvitationError', {
	code: Schema.Literals(['invalid', 'expired', 'accepted', 'revoked'])
}) {}

function toInvitation(row: InvitationRow): Invitation {
	return new Invitation({
		id: row.id,
		email: row.email,
		role: row.role,
		invitedByUserId: row.invitedByUserId,
		expiresAt: row.expiresAt,
		acceptedAt: row.acceptedAt,
		acceptedByUserId: row.acceptedByUserId,
		revokedAt: row.revokedAt,
		createdAt: row.createdAt
	});
}

function makeToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

function hashToken(token: string): Effect.Effect<string> {
	return Effect.promise(async () => {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
		return Buffer.from(digest).toString('hex');
	});
}

export class InvitationService extends Context.Service<
	InvitationService,
	{
		readonly create: (input: {
			readonly email: string;
			readonly role: Role;
			readonly invitedByUserId: string;
			readonly expiresAt?: Date;
		}) => Effect.Effect<{ readonly invitation: Invitation; readonly token: string }>;
		readonly list: Effect.Effect<ReadonlyArray<Invitation>>;
		readonly inspect: (token: string) => Effect.Effect<Invitation, InvitationError>;
		readonly accept: (id: string, userId: string) => Effect.Effect<Invitation, InvitationError>;
		readonly revoke: (id: string) => Effect.Effect<void, InvitationError>;
	}
>()('expensifier/InvitationService') {
	static readonly layerWithoutDependencies = Layer.effect(
		InvitationService,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			const selectColumns = sql`
				SELECT
					id,
					email,
					role,
					token_hash AS tokenHash,
					invited_by_user_id AS invitedByUserId,
					expires_at AS expiresAt,
					accepted_at AS acceptedAt,
					accepted_by_user_id AS acceptedByUserId,
					revoked_at AS revokedAt,
					created_at AS createdAt
				FROM invitations
			`;

			const create = Effect.fn('InvitationService.create')(function* (input: {
				readonly email: string;
				readonly role: Role;
				readonly invitedByUserId: string;
				readonly expiresAt?: Date;
			}) {
				const token = makeToken();
				const tokenHash = yield* hashToken(token);
				const now = new Date();
				const invitation = new Invitation({
					id: crypto.randomUUID(),
					email: input.email.trim().toLowerCase(),
					role: input.role,
					invitedByUserId: input.invitedByUserId,
					expiresAt: (
						input.expiresAt ?? new Date(now.getTime() + 72 * 60 * 60 * 1000)
					).toISOString(),
					acceptedAt: null,
					acceptedByUserId: null,
					revokedAt: null,
					createdAt: now.toISOString()
				});

				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`
							UPDATE invitations
							SET revoked_at = ${invitation.createdAt}
							WHERE email = ${invitation.email}
								AND accepted_at IS NULL
								AND revoked_at IS NULL
						`;
						yield* sql`
							INSERT INTO invitations (
								id, email, role, token_hash, invited_by_user_id, expires_at, created_at
							) VALUES (
								${invitation.id}, ${invitation.email}, ${invitation.role}, ${tokenHash},
								${invitation.invitedByUserId}, ${invitation.expiresAt}, ${invitation.createdAt}
							)
						`;
					})
				);

				return { invitation, token };
			}, Effect.orDie);

			const list = Effect.gen(function* () {
				const rows = yield* sql<InvitationRow>`
					${selectColumns}
					ORDER BY created_at DESC
				`;
				return rows.map(toInvitation);
			}).pipe(Effect.orDie, Effect.withSpan('InvitationService.list'));

			const inspect = Effect.fn('InvitationService.inspect')(function* (token: string) {
				const tokenHash = yield* hashToken(token);
				const rows = yield* sql<InvitationRow>`
					${selectColumns}
					WHERE token_hash = ${tokenHash}
					LIMIT 1
				`.pipe(Effect.orDie);
				const row = rows[0];
				if (!row) return yield* new InvitationError({ code: 'invalid' });
				if (row.acceptedAt) return yield* new InvitationError({ code: 'accepted' });
				if (row.revokedAt) return yield* new InvitationError({ code: 'revoked' });
				if (new Date(row.expiresAt).getTime() <= Date.now()) {
					return yield* new InvitationError({ code: 'expired' });
				}
				return toInvitation(row);
			});

			const accept = Effect.fn('InvitationService.accept')(function* (id: string, userId: string) {
				const now = new Date().toISOString();
				const rows = yield* sql<InvitationRow>`
					UPDATE invitations
					SET accepted_at = ${now}, accepted_by_user_id = ${userId}
					WHERE id = ${id}
						AND accepted_at IS NULL
						AND revoked_at IS NULL
						AND expires_at > ${now}
					RETURNING
						id, email, role, token_hash AS tokenHash,
						invited_by_user_id AS invitedByUserId, expires_at AS expiresAt,
						accepted_at AS acceptedAt, accepted_by_user_id AS acceptedByUserId,
						revoked_at AS revokedAt, created_at AS createdAt
				`.pipe(Effect.orDie);
				const row = rows[0];
				if (!row) return yield* new InvitationError({ code: 'invalid' });
				return toInvitation(row);
			});

			const revoke = Effect.fn('InvitationService.revoke')(function* (id: string) {
				const rows = yield* sql<{ readonly id: string }>`
					UPDATE invitations
					SET revoked_at = ${new Date().toISOString()}
					WHERE id = ${id} AND accepted_at IS NULL AND revoked_at IS NULL
					RETURNING id
				`.pipe(Effect.orDie);
				if (!rows[0]) return yield* new InvitationError({ code: 'invalid' });
			});

			return InvitationService.of({ create, list, inspect, accept, revoke });
		})
	);

	static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(DatabaseLive));
}
