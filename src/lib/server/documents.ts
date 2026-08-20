import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

import { runtimeConfig } from './config';
import { DatabaseLive } from './database';

const DocumentStatus = Schema.Literals(['intake_pending', 'processing', 'failed']);

export class Document extends Schema.Class<Document>('Document')({
	id: Schema.String,
	status: DocumentStatus,
	originalFilename: Schema.String,
	currentRelativePath: Schema.String,
	mimeType: Schema.String,
	extension: Schema.String,
	byteSize: Schema.Number,
	contentHash: Schema.String,
	sourceIdentity: Schema.String,
	intakeSource: Schema.Literal('watched_folder'),
	duplicateOfDocumentId: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String,
	managedAt: Schema.NullOr(Schema.String)
}) {}

export class QueueItem extends Schema.Class<QueueItem>('QueueItem')({
	document: Document,
	jobStatus: Schema.Literals(['pending', 'running', 'succeeded', 'failed']),
	attemptCount: Schema.Number,
	maxAttempts: Schema.Number,
	errorCode: Schema.NullOr(Schema.String),
	nextAttemptAt: Schema.NullOr(Schema.String)
}) {}

export interface StageDocumentInput {
	readonly originalFilename: string;
	readonly currentRelativePath: string;
	readonly mimeType: string;
	readonly extension: string;
	readonly byteSize: number;
	readonly contentHash: string;
	readonly sourceIdentity: string;
}

const documentColumns = `
	id, status, original_filename AS originalFilename,
	current_relative_path AS currentRelativePath, mime_type AS mimeType,
	extension, byte_size AS byteSize, content_hash AS contentHash,
	source_identity AS sourceIdentity, intake_source AS intakeSource,
	duplicate_of_document_id AS duplicateOfDocumentId, created_at AS createdAt,
	updated_at AS updatedAt, managed_at AS managedAt
`;

const joinedDocumentColumns = `
	documents.id AS id, documents.status AS status,
	documents.original_filename AS originalFilename,
	documents.current_relative_path AS currentRelativePath,
	documents.mime_type AS mimeType, documents.extension AS extension,
	documents.byte_size AS byteSize, documents.content_hash AS contentHash,
	documents.source_identity AS sourceIdentity, documents.intake_source AS intakeSource,
	documents.duplicate_of_document_id AS duplicateOfDocumentId,
	documents.created_at AS createdAt, documents.updated_at AS updatedAt,
	documents.managed_at AS managedAt
`;

export class DocumentRepository extends Context.Service<
	DocumentRepository,
	{
		readonly stage: (
			input: StageDocumentInput
		) => Effect.Effect<{ readonly document: Document; readonly created: boolean }>;
		readonly findById: (id: string) => Effect.Effect<Document | null>;
		readonly listPendingMoves: Effect.Effect<ReadonlyArray<Document>>;
		readonly markManaged: (id: string, currentRelativePath: string) => Effect.Effect<void>;
		readonly markFailed: (id: string) => Effect.Effect<void>;
		readonly queue: Effect.Effect<ReadonlyArray<QueueItem>>;
	}
>()('expensifier/DocumentRepository') {
	static readonly layerWithoutDependencies = Layer.effect(
		DocumentRepository,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			const findById = Effect.fn('DocumentRepository.findById')(function* (id: string) {
				const rows =
					yield* sql<Document>`SELECT ${sql.unsafe(documentColumns)} FROM documents WHERE id = ${id}`;
				return rows[0] ? new Document(rows[0]) : null;
			}, Effect.orDie);

			const stage = Effect.fn('DocumentRepository.stage')(function* (input: StageDocumentInput) {
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						const existing = yield* sql<Document>`
							SELECT ${sql.unsafe(documentColumns)}
							FROM documents WHERE source_identity = ${input.sourceIdentity}
						`;
						if (existing[0]) return { document: new Document(existing[0]), created: false };

						const duplicate = yield* sql<{ readonly id: string }>`
							SELECT id FROM documents
							WHERE content_hash = ${input.contentHash}
							ORDER BY created_at LIMIT 1
						`;
						const now = new Date().toISOString();
						const document = new Document({
							id: crypto.randomUUID(),
							status: 'intake_pending',
							...input,
							intakeSource: 'watched_folder',
							duplicateOfDocumentId: duplicate[0]?.id ?? null,
							createdAt: now,
							updatedAt: now,
							managedAt: null
						});

						yield* sql`
							INSERT INTO documents (
								id, status, original_filename, current_relative_path, mime_type,
								extension, byte_size, content_hash, source_identity, intake_source,
								duplicate_of_document_id, created_at, updated_at
							) VALUES (
								${document.id}, ${document.status}, ${document.originalFilename},
								${document.currentRelativePath}, ${document.mimeType}, ${document.extension},
								${document.byteSize}, ${document.contentHash}, ${document.sourceIdentity},
								${document.intakeSource}, ${document.duplicateOfDocumentId},
								${document.createdAt}, ${document.updatedAt}
							)
						`;
						yield* sql`
							INSERT INTO jobs (
								id, type, status, related_entity_id, attempt_count, max_attempts,
								next_attempt_at, created_at, updated_at
							) VALUES (
								${crypto.randomUUID()}, 'intake_document', 'pending', ${document.id},
								0, ${runtimeConfig.jobMaxAttempts}, ${now}, ${now}, ${now}
							)
						`;
						return { document, created: true };
					})
				);
			}, Effect.orDie);

			const listPendingMoves = sql<Document>`
				SELECT ${sql.unsafe(documentColumns)}
				FROM documents WHERE status = 'intake_pending'
				ORDER BY created_at
			`.pipe(
				Effect.map((rows) => rows.map((row) => new Document(row))),
				Effect.orDie
			);

			const markManaged = Effect.fn('DocumentRepository.markManaged')(function* (
				id: string,
				currentRelativePath: string
			) {
				const now = new Date().toISOString();
				yield* sql`
					UPDATE documents SET status = 'processing', current_relative_path = ${currentRelativePath},
						managed_at = COALESCE(managed_at, ${now}), updated_at = ${now}
					WHERE id = ${id}
				`;
			}, Effect.orDie);

			const markFailed = Effect.fn('DocumentRepository.markFailed')(function* (id: string) {
				yield* sql`
					UPDATE documents SET status = 'failed', updated_at = ${new Date().toISOString()}
					WHERE id = ${id}
				`;
			}, Effect.orDie);

			const queue = Effect.gen(function* () {
				const rows = yield* sql<
					Document & {
						readonly jobStatus: QueueItem['jobStatus'];
						readonly attemptCount: number;
						readonly maxAttempts: number;
						readonly errorCode: string | null;
						readonly nextAttemptAt: string | null;
					}
				>`
					SELECT ${sql.unsafe(joinedDocumentColumns)},
						jobs.status AS jobStatus, jobs.attempt_count AS attemptCount,
						jobs.max_attempts AS maxAttempts, jobs.error_code AS errorCode,
						jobs.next_attempt_at AS nextAttemptAt
					FROM documents
					JOIN jobs ON jobs.related_entity_id = documents.id AND jobs.type = 'intake_document'
					ORDER BY documents.created_at DESC
				`;
				return rows.map(
					(row) =>
						new QueueItem({
							document: new Document(row),
							jobStatus: row.jobStatus,
							attemptCount: row.attemptCount,
							maxAttempts: row.maxAttempts,
							errorCode: row.errorCode,
							nextAttemptAt: row.nextAttemptAt
						})
				);
			}).pipe(Effect.orDie);

			return DocumentRepository.of({
				stage,
				findById,
				listPendingMoves,
				markManaged,
				markFailed,
				queue
			});
		})
	);

	static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(DatabaseLive));
}
